// crate engine — walks similarity graphs (Deezer, optionally Last.fm) outward
// from seeds and returns tracks the listener hasn't heard, with provenance.
// Pure module: runs in the browser and in Node (check.mjs). All I/O goes
// through the `api` object: { dz(pathAndQuery), lastfm(params)|null }.

export function normKey(artist, title) {
  const clean = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/\((feat|ft|with|prod)[^)]*\)/g, "")
      .replace(/\[(feat|ft|with|prod)[^\]]*\]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ");
  return clean(artist) + "::" + clean(title);
}

export const artistKey = (name) => String(name || "").toLowerCase().trim();

const jitter = () => 0.7 + Math.random() * 0.6;
const yearOf = (d) => {
  const y = parseInt(String(d || "").slice(0, 4), 10);
  return Number.isFinite(y) && y > 1900 ? y : null;
};

function pickWeighted(items, weightFn, n) {
  const pool = items.map((it) => ({ it, w: Math.max(0.0001, weightFn(it)) }));
  const out = [];
  while (out.length < n && pool.length) {
    let total = 0;
    for (const p of pool) total += p.w;
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w;
      if (r <= 0) { idx = i; break; }
    }
    out.push(pool[idx].it);
    pool.splice(idx, 1);
  }
  return out;
}

// obscurity slider 0..1 → max artist fan count (log scale, ~6M → ~15k)
export function maxFansFor(obscurity) {
  return Math.round(Math.pow(10, 6.8 - 2.2 * obscurity));
}

async function resolveArtist(api, name) {
  // Deezer search surfaces tiny namesakes first — take a wide slice and
  // prefer the biggest artist whose name matches exactly
  const j = await api.dz("search/artist?q=" + encodeURIComponent(name) + "&limit=25");
  const list = j?.data || [];
  if (!list.length) return null;
  const want = artistKey(name);
  const exact = list.filter((a) => artistKey(a.name) === want);
  if (exact.length) return exact.reduce((best, a) => ((a.nb_fan || 0) > (best.nb_fan || 0) ? a : best));
  return list[0];
}

async function relatedArtists(api, artistId, limit = 25) {
  const j = await api.dz(`artist/${artistId}/related?limit=${limit}`);
  return j?.data || [];
}

async function lastfmSimilarNames(api, name) {
  if (!api.lastfm) return [];
  try {
    const j = await api.lastfm({ method: "artist.getSimilar", artist: name, autocorrect: "1", limit: "12" });
    const arr = j?.similarartists?.artist || [];
    return arr.map((a) => a.name).filter(Boolean);
  } catch {
    return [];
  }
}

async function lastfmSimilarTracks(api, artist, title) {
  if (!api.lastfm) return [];
  try {
    const j = await api.lastfm({ method: "track.getSimilar", artist, track: title, autocorrect: "1", limit: "36" });
    const arr = j?.similartracks?.track || [];
    return arr.map((t) => ({ title: t.name, artist: t.artist?.name })).filter((t) => t.title && t.artist);
  } catch {
    return [];
  }
}

function fromDeezerTrack(t, fallbackArtist, extra = {}) {
  if (!t) return null;
  return {
    dzId: t.id,
    title: t.title || t.title_short, // full title keeps remix/version info
    artist: t.artist?.name || fallbackArtist?.name || "",
    artistDzId: t.artist?.id || fallbackArtist?.id || null,
    album: extra.album || t.album?.title || "",
    albumId: extra.albumId || t.album?.id || null,
    year: extra.year || yearOf(t.album?.release_date) || null,
    art: extra.art || t.album?.cover_big || t.album?.cover_medium || fallbackArtist?.picture_big || "",
    preview: t.preview || "",
    rank: t.rank || 0,
    duration: t.duration || 0,
    via: extra.via || "",
  };
}

// shared final pass: previews only, nothing known/seen, dedupe, diversify, cut
function finalize(found, opts) {
  const {
    mode = "new", yearCap = null, hasTrack = () => false, isSeen = () => false,
    obscurity = 0.5, batchSize = 48, maxPerArtist = 1, maxPerAlbum = 1,
  } = opts;
  const keys = new Set();
  let batch = [];
  for (const t of found) {
    if (!t || !t.preview) continue;
    const key = normKey(t.artist, t.title);
    if (keys.has(key)) continue;
    keys.add(key);
    if (hasTrack(key, t.isrc)) continue;
    if (isSeen(key)) continue;
    if (mode === "gems" && yearCap && t.year && t.year > yearCap) continue;
    batch.push({ ...t, key });
  }
  const perArtist = {}, perAlbum = {};
  return pickWeighted(batch, (t) => {
    const r = t.rank || 200000;
    return jitter() * (obscurity > 0.5 ? 1 / Math.log10(r + 10) : Math.log10(r + 10) / 6);
  }, batch.length).filter((t) => {
    const a = artistKey(t.artist);
    perArtist[a] = (perArtist[a] || 0) + 1;
    if (perArtist[a] > maxPerArtist) return false;
    if (t.albumId) {
      perAlbum[t.albumId] = (perAlbum[t.albumId] || 0) + 1;
      if (perAlbum[t.albumId] > maxPerAlbum) return false;
    }
    return true;
  }).slice(0, batchSize);
}

// opts:
//   mode: 'new' | 'gems' | 'deep'
//   seeds: [artistName]            — chosen upstream (taste-weighted or manual)
//   farOut: 0..1                   — how far the graph walk wanders
//   obscurity: 0..1                — how mainstream candidates may be
//   yearCap: number|null           — gems: only releases ≤ this year
//   isKnownArtist(key) -> count    — how present an artist is in the library
//   hasTrack(key, isrc) -> bool    — track already in library
//   isSeen(key) -> bool            — heard recently / banned
//   artistPenalty(key) -> 0..1     — learned dislike (0 = never show)
//   batchSize, log(msg)
export async function dig(api, opts) {
  const {
    mode = "new", seeds = [], farOut = 0.4, obscurity = 0.5, yearCap = null,
    isKnownArtist = () => 0, hasTrack = () => false, isSeen = () => false,
    artistPenalty = () => 1, batchSize = 48, log = () => {},
  } = opts;

  const maxFans = maxFansFor(obscurity);

  // 1. resolve seeds on Deezer
  const seedArtists = [];
  for (const name of seeds.slice(0, 3)) {
    const a = await resolveArtist(api, name);
    if (a) seedArtists.push(a);
  }
  if (!seedArtists.length) return { tracks: [], seeds: [] };
  log(`digging from ${seedArtists.map((a) => a.name).join(", ")}`);

  // 2. build candidate pool with provenance: hop 1 from each seed…
  const pool = new Map(); // id -> { artist, via }
  const add = (a, via) => {
    if (a && a.id && !pool.has(a.id)) pool.set(a.id, { artist: a, via });
  };
  for (const seed of seedArtists) {
    (await relatedArtists(api, seed.id, 25)).forEach((a) => add(a, seed.name));
    for (const n of (await lastfmSimilarNames(api, seed.name)).slice(0, 5)) {
      if ([...pool.values()].some((p) => artistKey(p.artist.name) === artistKey(n))) continue;
      add(await resolveArtist(api, n), seed.name);
    }
    if (mode !== "new") add(seed, seed.name); // gems/deep may dig the seed itself
  }

  // …then always a second hop, deeper when far out — this is what gets past
  // the adjacent-hits layer of the graph
  const hop1 = [...pool.values()];
  const expansions = pickWeighted(
    hop1,
    (p) => 1 / Math.log10((p.artist.nb_fan || 100) + 10),
    Math.min(hop1.length, 1 + Math.round(farOut * 3))
  );
  for (const ex of expansions) {
    (await relatedArtists(api, ex.artist.id, 20)).forEach((a) => add(a, `${ex.via} → ${ex.artist.name}`));
  }
  // some artists have no related graph at all — dig their own catalog rather than nothing
  if (!pool.size) seedArtists.forEach((s) => add(s, s.name));
  log(`${pool.size} artists surveyed`);

  // 3. filter pool by mode, fan budget, learned dislikes
  let candidates = [...pool.values()].filter((p) => artistPenalty(artistKey(p.artist.name)) > 0);
  const known = (p) => isKnownArtist(artistKey(p.artist.name));
  if (mode === "new") {
    let fresh = candidates.filter((p) => known(p) < 2);
    if (fresh.length < 4) fresh = candidates.filter((p) => known(p) < 5);
    candidates = fresh.length ? fresh : candidates;
  } else if (mode === "deep") {
    const k = candidates.filter((p) => known(p) >= 2);
    candidates = k.length ? k : candidates;
  }
  let inBudget = candidates.filter((p) => (p.artist.nb_fan || 0) <= maxFans);
  if (inBudget.length < 4) inBudget = candidates; // don't starve on tiny scenes
  candidates = inBudget;

  const chosen = pickWeighted(
    candidates,
    (p) => (artistPenalty(artistKey(p.artist.name)) * jitter()) / Math.log10((p.artist.nb_fan || 100) + 10),
    Math.min(mode === "new" ? 22 : 9, candidates.length)
  );
  log(`${chosen.length} artists in the crate`);

  // 4. collect tracks
  const found = [];
  const dropHits = 2 + Math.round(obscurity * 8); // skip each artist's biggest songs

  for (const { artist, via } of chosen) {
    try {
      if (mode === "new") {
        // mid-catalog sampling, not the hits
        const j = await api.dz(`artist/${artist.id}/top?limit=50`);
        const all = j?.data || [];
        const byPop = [...all].sort((a, b) => (b.rank || 0) - (a.rank || 0));
        let eligible = byPop.slice(Math.min(dropHits, Math.max(0, byPop.length - 5)));
        if (!eligible.length) eligible = all;
        for (const t of pickWeighted(eligible, (tt) => (obscurity > 0.4 ? 1 / Math.log10((tt.rank || 100000) + 10) : jitter()), 2)) {
          found.push(fromDeezerTrack(t, artist, { via }));
        }
      } else {
        // gems / deep: go through albums so we get release years + non-hits
        const j = await api.dz(`artist/${artist.id}/albums?limit=100`);
        let albums = (j?.data || []).filter((al) => al.record_type === "album" || al.record_type === "ep");
        if (mode === "gems" && yearCap) albums = albums.filter((al) => (yearOf(al.release_date) || 9999) <= yearCap);
        if (!albums.length) continue;
        const picks = pickWeighted(albums, (al) => {
          const y = yearOf(al.release_date) || 2020;
          return mode === "gems" ? 1 + (2030 - y) / 20 : jitter();
        }, 2);
        for (const al of picks) {
          const alj = await api.dz(`album/${al.id}`);
          const tracks = alj?.tracks?.data || [];
          const y = yearOf(alj?.release_date || al.release_date);
          const art = alj?.cover_big || al.cover_big || al.cover_medium;
          let list = tracks;
          if (mode === "deep" && list.length > 4) {
            // deep cuts: drop the album's most popular quarter
            const sorted = [...list].sort((a, b) => (b.rank || 0) - (a.rank || 0));
            const hot = new Set(sorted.slice(0, Math.ceil(list.length / 4)).map((t) => t.id));
            list = list.filter((t) => !hot.has(t.id));
          }
          for (const t of pickWeighted(list, () => jitter(), 3)) {
            found.push(fromDeezerTrack(t, artist, { album: al.title || alj?.title, albumId: al.id, year: y, art, via }));
          }
        }
      }
    } catch (e) {
      log(`skipping ${artist.name}: ${e.message || e}`);
    }
  }

  // 5-6. filter + diversify: a wall of distinct artists in "new" mode
  const caps = mode === "new" ? { maxPerArtist: 1, maxPerAlbum: 1 } : { maxPerArtist: 3, maxPerAlbum: 2 };
  const batch = finalize(found, { mode, yearCap, hasTrack, isSeen, obscurity, batchSize, ...caps });
  return { tracks: batch, seeds: seedArtists.map((a) => a.name) };
}

// song → song: Last.fm track similarity when a key is configured, artist-graph
// tunnel as fallback. Seeded from one specific track ("dig from this").
export async function digFromTrack(api, opts) {
  const {
    artist, title, obscurity = 0.5,
    isKnownArtist = () => 0, hasTrack = () => false, isSeen = () => false,
    artistPenalty = () => 1, batchSize = 40, log = () => {},
  } = opts;

  log(`looking for songs like “${title}”…`);
  const found = [];
  const sims = await lastfmSimilarTracks(api, artist, title);
  for (const s of sims.slice(0, 28)) {
    try {
      const q = `artist:"${s.artist}" track:"${s.title}"`;
      const j = await api.dz(`search?q=${encodeURIComponent(q)}&limit=3`);
      const hit = (j?.data || []).find((t) => t.preview);
      if (hit) found.push(fromDeezerTrack(hit, null, { via: `similar to ${title}` }));
    } catch {}
  }
  let out = finalize(found, { hasTrack, isSeen, obscurity, batchSize, maxPerArtist: 2, maxPerAlbum: 1 });

  if (out.length < 12) {
    log(sims.length ? "thin similars — widening through the artist graph…" : "no last.fm key — walking the artist graph instead…");
    const sub = await dig(api, {
      mode: "new", seeds: [artist], farOut: 0.5, obscurity,
      isKnownArtist, hasTrack, isSeen, artistPenalty,
      batchSize: batchSize - out.length, log,
    });
    const have = new Set(out.map((t) => t.key));
    out = out.concat(sub.tracks.filter((t) => !have.has(t.key)));
  }
  return { tracks: out.slice(0, batchSize), seeds: [`${artist} — ${title}`] };
}
