// crate engine — walks similarity graphs (Deezer, optionally Last.fm) outward
// from seed artists and returns candidate tracks the listener hasn't heard.
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
  const j = await api.dz("search/artist?q=" + encodeURIComponent(name) + "&limit=5");
  const list = j?.data || [];
  if (!list.length) return null;
  const want = artistKey(name);
  return list.find((a) => artistKey(a.name) === want) || list[0];
}

async function relatedArtists(api, artistId) {
  const j = await api.dz(`artist/${artistId}/related?limit=20`);
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

// opts:
//   mode: 'new' | 'gems' | 'deep'
//   seeds: [artistName]           — chosen upstream (taste-weighted or manual)
//   farOut: 0..1                  — how far to wander from the seeds
//   obscurity: 0..1               — how mainstream candidates may be
//   yearCap: number|null          — gems: only releases ≤ this year
//   isKnownArtist(name) -> count  — how present an artist is in the library
//   hasTrack(key, isrc) -> bool   — track already in library
//   isSeen(key) -> bool           — shown recently / banned
//   batchSize
//   log(msg)                      — progress
export async function dig(api, opts) {
  const {
    mode = "new", seeds = [], farOut = 0.4, obscurity = 0.5, yearCap = null,
    isKnownArtist = () => 0, hasTrack = () => false, isSeen = () => false,
    batchSize = 48, log = () => {},
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

  // 2. build candidate artist pool
  const pool = new Map(); // id -> artist
  const addToPool = (a) => {
    if (a && a.id && !pool.has(a.id)) pool.set(a.id, a);
  };

  for (const seed of seedArtists) {
    const rel = await relatedArtists(api, seed.id);
    rel.forEach(addToPool);
    // optional Last.fm hop — different graph, catches what Deezer misses
    const lfNames = await lastfmSimilarNames(api, seed.name);
    for (const n of lfNames.slice(0, 5)) {
      if ([...pool.values()].some((a) => artistKey(a.name) === artistKey(n))) continue;
      const a = await resolveArtist(api, n);
      addToPool(a);
    }
    if (mode !== "new") addToPool(seed); // gems/deep may dig the seed itself
  }

  // far out → take one extra hop from a random related artist
  if (farOut > 0.6 && pool.size) {
    const hopFrom = pickWeighted([...pool.values()], () => 1, Math.ceil(farOut * 2));
    for (const h of hopFrom) {
      const rel2 = await relatedArtists(api, h.id);
      rel2.slice(0, 10).forEach(addToPool);
    }
  }

  // 3. filter pool by mode + obscurity
  let candidates = [...pool.values()];
  const knownCount = (a) => isKnownArtist(artistKey(a.name));
  if (mode === "new") {
    let fresh = candidates.filter((a) => knownCount(a) < 2);
    if (fresh.length < 4) fresh = candidates.filter((a) => knownCount(a) < 5);
    candidates = fresh.length ? fresh : candidates;
  } else if (mode === "deep") {
    const known = candidates.filter((a) => knownCount(a) >= 2);
    candidates = known.length ? known : candidates;
  }
  let inBudget = candidates.filter((a) => (a.nb_fan || 0) <= maxFans);
  if (inBudget.length < 4) inBudget = candidates; // don't starve on tiny scenes
  candidates = inBudget;

  const chosen = pickWeighted(
    candidates,
    (a) => jitter() / Math.log10((a.nb_fan || 100) + 10),
    Math.min(12, candidates.length)
  );
  log(`${chosen.length} artists in the crate`);

  // 4. collect tracks
  const found = [];
  const skipHits = Math.round(obscurity * 4); // new mode: skip an artist's top K hits

  for (const artist of chosen) {
    try {
      if (mode === "new") {
        const j = await api.dz(`artist/${artist.id}/top?limit=25`);
        const tracks = (j?.data || []).slice(skipHits);
        for (const t of tracks.slice(0, 8)) found.push(fromDeezerTrack(t, artist));
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
          for (const t of pickWeighted(list, () => jitter(), 4)) {
            found.push(fromDeezerTrack(t, artist, { album: al.title || alj?.title, year: y, art }));
          }
        }
      }
    } catch (e) {
      log(`skipping ${artist.name}: ${e.message || e}`);
    }
  }

  // 5. filter: previews only, nothing known, nothing seen, dedupe
  const seenKeys = new Set();
  let batch = [];
  for (const t of found) {
    if (!t || !t.preview) continue;
    const key = normKey(t.artist, t.title);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    if (hasTrack(key, t.isrc)) continue;
    if (isSeen(key)) continue;
    if (mode === "gems" && yearCap && t.year && t.year > yearCap) continue;
    batch.push({ ...t, key });
  }

  // 6. diversify (cap per artist) + bias by obscurity, then cut to size
  const perArtist = {};
  const maxPer = mode === "new" ? 2 : 3;
  batch = pickWeighted(batch, (t) => {
    const r = t.rank || 200000;
    return jitter() * (obscurity > 0.5 ? 1 / Math.log10(r + 10) : Math.log10(r + 10) / 6);
  }, batch.length).filter((t) => {
    const k = artistKey(t.artist);
    perArtist[k] = (perArtist[k] || 0) + 1;
    return perArtist[k] <= maxPer;
  }).slice(0, batchSize);

  return { tracks: batch, seeds: seedArtists.map((a) => a.name) };
}

function fromDeezerTrack(t, fallbackArtist, extra = {}) {
  if (!t) return null;
  return {
    dzId: t.id,
    title: t.title || t.title_short, // full title keeps remix/version info

    artist: t.artist?.name || fallbackArtist?.name || "",
    artistDzId: t.artist?.id || fallbackArtist?.id || null,
    album: extra.album || t.album?.title || "",
    year: extra.year || yearOf(t.album?.release_date) || null,
    art: extra.art || t.album?.cover_big || t.album?.cover_medium || fallbackArtist?.picture_big || "",
    preview: t.preview || "",
    rank: t.rank || 0,
    duration: t.duration || 0,
  };
}
