// crate — client app: Spotify auth + library profile, taste lanes, dig UI,
// previews, drift, save/queue-back to Spotify.
import {
  dig, digFromTrack, digBridge, digDescent, digNeighbors, digCircling, digLabel,
  songPanel, buildPlaylist, normKey, artistKey,
} from "./engine.js";

const BASE = location.origin;
// local install talks to server.js (file store); the deployed site keeps
// everything in this browser's localStorage — tokens never leave the device
const LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
const REDIRECT_URI = BASE + "/callback"; // must be registered in the Spotify dashboard
// The site's default app id (a public identifier — PKCE apps always ship it).
// Invited listeners just hit Connect; anyone else can paste their own in settings.
const DEFAULT_CLIENT_ID = "cfdc9a965ad34cc1bba6c2db96404638";
const SCOPES = "user-library-read user-library-modify user-top-read playlist-read-private playlist-modify-private playlist-modify-public user-modify-playback-state user-read-playback-state";

const DEFAULT_STORE = {
  spotify: { clientId: "", tokens: null, userId: "", userName: "" },
  lastfm: { apiKey: "" },
  settings: { playlist: true, playlistId: null, hoverPlay: true },
  profile: { builtAt: 0, newestAddedAt: "", count: 0, artists: {}, top: {}, lanes: null, trackKeys: [], isrcs: [], years: {} },
  seen: {}, banned: {}, saved: {}, savedLocal: [], finds: [],
};

const $ = (sel) => document.querySelector(sel);
// ?preview=1 — screenshot/test mode: dig freely but never scan, mark seen, or persist
const PREVIEW = new URLSearchParams(location.search).has("preview");
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// ---------- state ----------
let store = null;
let trackKeySet = new Set();
let isrcSet = new Set();
let batch = [];
let currentIdx = -1;
let digging = false;
let scanAbort = false;
let activeLane = null; // null = everything
const playedIdx = new Set();
const audio = new Audio();
audio.preload = "none";

const api = {
  dz: async (pathAndQuery) => {
    const r = await fetch("/api/deezer/" + pathAndQuery);
    const j = await r.json();
    if (j && j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j;
  },
  lastfm: null, // set after store loads if a key exists
};

async function loadStore() {
  if (LOCAL) {
    store = await (await fetch("/api/store")).json();
  } else {
    try { store = JSON.parse(localStorage.getItem("crateStore")); } catch { store = null; }
    if (!store) store = structuredClone(DEFAULT_STORE);
  }
  store.profile.lanes = store.profile.lanes || null;
  store.finds = store.finds || [];
  if (!store.settings.playlistMode) store.settings.playlistMode = store.settings.playlist === false ? "none" : "crate";
  trackKeySet = new Set(store.profile.trackKeys || []);
  isrcSet = new Set(store.profile.isrcs || []);
  // prune stale seen entries (30 days)
  const now = Date.now();
  for (const [k, ts] of Object.entries(store.seen)) if (now - ts > 30 * 24 * 3600 * 1000) delete store.seen[k];
  if (store.lastfm.apiKey) {
    api.lastfm = async (params) => (await fetch("/api/lastfm?" + new URLSearchParams(params))).json();
  }
}

let saveTimer = null;
function persist(now = false) {
  if (PREVIEW) return;
  clearTimeout(saveTimer);
  const doSave = () => LOCAL
    ? fetch("/api/store", { method: "POST", body: JSON.stringify(store) })
    : Promise.resolve(localStorage.setItem("crateStore", JSON.stringify(store)));
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 800);
}

function status(msg) {
  $("#status").textContent = msg || "";
  hideStatusAction();
}

// one contextual button beside the status line ("save this set to spotify")
let statusActFn = null;
function showStatusAction(label, fn) {
  const b = $("#statusact");
  if (!b) return;
  b.textContent = label;
  b.hidden = false;
  statusActFn = fn;
}
function hideStatusAction() {
  const b = $("#statusact");
  if (b) { b.hidden = true; statusActFn = null; }
}

// ---------- learned dislike: repeated bans of an artist bury the branch ----------
const softKey = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function makeArtistPenalty() {
  const counts = {};
  for (const key of Object.keys(store.banned)) {
    const a = key.split("::")[0];
    counts[a] = (counts[a] || 0) + 1;
  }
  return (ak) => {
    const c = counts[softKey(ak)] || 0;
    return c >= 4 ? 0 : c >= 2 ? 0.25 : 1;
  };
}

function digCallbacks() {
  const now = Date.now();
  return {
    isKnownArtist: (k) => store.profile.artists[k] || 0,
    hasTrack: (key, isrc) => trackKeySet.has(key) || (isrc && isrcSet.has(isrc)),
    isSeen: (key) => {
      if (store.banned[key]) return true;
      const ts = store.seen[key];
      return ts && now - ts < 14 * 24 * 3600 * 1000;
    },
    artistPenalty: makeArtistPenalty(),
  };
}

// ---------- spotify auth (PKCE) ----------
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function login() {
  if (!store.spotify.clientId) {
    store.spotify.clientId = DEFAULT_CLIENT_ID;
    persist();
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem("pkce_verifier", verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  location.href = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: store.spotify.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
}

async function tokenRequest(params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: store.spotify.clientId, ...params }),
  });
  if (!r.ok) throw new Error("token request failed: " + (await r.text()));
  return r.json();
}

async function handleCallback() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return false;
  try {
    const t = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: localStorage.getItem("pkce_verifier") || "",
    });
    store.spotify.tokens = { at: t.access_token, rt: t.refresh_token, exp: Date.now() + t.expires_in * 1000 };
    await persist(true);
  } catch (e) {
    status("spotify login failed — " + e.message);
  }
  history.replaceState({}, "", "/");
  return true;
}

async function freshToken() {
  const tok = store.spotify.tokens;
  if (!tok) return null;
  if (Date.now() < tok.exp - 60000) return tok.at;
  // preview/screenshot mode must never rotate the refresh token — a rotation
  // that isn't persisted would strand the real session's stored token
  if (PREVIEW) return null;
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: tok.rt });
    store.spotify.tokens = {
      at: t.access_token,
      rt: t.refresh_token || tok.rt,
      exp: Date.now() + t.expires_in * 1000,
    };
    persist();
    return t.access_token;
  } catch {
    store.spotify.tokens = null;
    persist();
    return null;
  }
}

async function sp(path, opts = {}, retried = false) {
  const at = await freshToken();
  if (!at) throw new Error("not connected to spotify");
  const r = await fetch("https://api.spotify.com/v1" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + at, ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
  });
  if (r.status === 429 && !retried) {
    const wait = (parseInt(r.headers.get("Retry-After") || "2", 10) + 1) * 1000;
    await new Promise((res) => setTimeout(res, wait));
    return sp(path, opts, true);
  }
  if (r.status === 401 && !retried) {
    store.spotify.tokens && (store.spotify.tokens.exp = 0);
    return sp(path, opts, true);
  }
  if (!r.ok) throw new Error(`spotify ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// ---------- taste lanes ----------
// order matters: earlier lanes claim overlapping genre strings first
const GENRE_LANES = [
  ["rap", /hip hop|rap|trap|drill|grime|boom bap|phonk/],
  ["electronic", /electro|techno|house|edm|idm|ambient|drum and bass|dnb|dubstep|garage|synth|downtempo|trip hop|breakbeat|glitch|jungle|rave|club/],
  ["r&b / soul", /r&b|soul|funk|motown|quiet storm|new jack/],
  ["indie / rock", /indie|rock|shoegaze|punk|emo|grunge|slacker|lo-fi|post-|alt z|alternative/],
  ["jazz", /jazz|bop|bossa|swing|fusion/],
  ["metal", /metal|djent|hardcore|deathcore/],
  ["folk / country", /folk|country|americana|singer-songwriter|bluegrass|acoustic/],
  ["classical / score", /classical|orchestra|baroque|compositional|soundtrack|score/],
  ["global", /latin|afro|reggae|dancehall|k-pop|j-pop|city pop|bollywood|arab|cumbia|salsa|amapiano|highlife/],
  ["pop", /pop/],
];
const laneFor = (genre) => (GENRE_LANES.find(([, re]) => re.test(genre)) || [null])[0];

async function scanTopAndLanes(save = true) {
  const p = store.profile;
  const lanes = {};
  for (const range of ["long_term", "medium_term", "short_term"]) {
    try {
      const top = await sp(`/me/top/artists?time_range=${range}&limit=50`);
      top.items.forEach((a, i) => {
        const k = artistKey(a.name);
        p.top[k] = Math.max(p.top[k] || 0, 50 - i);
        const w = (p.artists[k] || 1) + (50 - i) / 10;
        for (const lane of new Set((a.genres || []).map(laneFor).filter(Boolean))) {
          lanes[lane] = lanes[lane] || {};
          lanes[lane][k] = Math.max(lanes[lane][k] || 0, w);
        }
      });
    } catch {}
  }
  if (Object.keys(lanes).length) p.lanes = lanes;
  if (save) persist(true);
  renderLanes();
}

function renderLanes() {
  const wrap = $("#lanes");
  if (!wrap) return;
  wrap.innerHTML = "";
  const lanes = store.profile.lanes;
  if (!lanes || !Object.keys(lanes).length) return;
  const ranked = Object.entries(lanes)
    .map(([name, artists]) => [name, Object.values(artists).reduce((a, b) => a + b, 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const mk = (label, lane) => {
    const b = el("button", lane === activeLane ? "on" : "", label);
    b.addEventListener("click", () => {
      activeLane = lane;
      renderLanes();
      runDig(false);
    });
    wrap.append(b);
  };
  mk("everything", null);
  for (const [name] of ranked) mk(name, name);
}

// ---------- library scan ----------
async function scanLibrary(full = false) {
  scanAbort = false;
  const p = store.profile;
  if (full) Object.assign(p, { builtAt: 0, newestAddedAt: "", count: 0, artists: {}, top: {}, lanes: null, trackKeys: [], isrcs: [], years: {} });
  const newestKnown = p.newestAddedAt || "";
  let offset = 0, added = 0, newest = newestKnown, done = false;

  try {
    const me = await sp("/me");
    store.spotify.userId = me.id;
    store.spotify.userName = me.display_name || me.id;
  } catch (e) {
    status("connect spotify first — " + e.message);
    return;
  }

  while (!done && !scanAbort) {
    const page = await sp(`/me/tracks?limit=50&offset=${offset}`);
    for (const item of page.items) {
      if (newestKnown && item.added_at <= newestKnown) { done = true; break; }
      const t = item.track;
      if (!t) continue;
      if (!newest || item.added_at > newest) newest = item.added_at;
      const primary = t.artists?.[0]?.name || "";
      (t.artists || []).forEach((a, i) => {
        const k = artistKey(a.name);
        p.artists[k] = (p.artists[k] || 0) + (i === 0 ? 1 : 0.4); // feature credits count less
      });
      const key = normKey(primary, t.name);
      if (!trackKeySet.has(key)) { trackKeySet.add(key); p.trackKeys.push(key); }
      const isrc = t.external_ids?.isrc;
      if (isrc && !isrcSet.has(isrc)) { isrcSet.add(isrc); p.isrcs.push(isrc); }
      const y = parseInt(String(t.album?.release_date || "").slice(0, 4), 10);
      if (y) p.years[y] = (p.years[y] || 0) + 1;
      added++;
    }
    offset += 50;
    if (!page.next) done = true;
    status(`scanning liked songs… ${p.count + added}`);
    await new Promise((r) => setTimeout(r, 80));
  }
  p.count += added;
  p.newestAddedAt = newest;
  p.builtAt = Date.now();
  await scanTopAndLanes(false);
  await persist(true);
  renderStatusLine();
  status(added ? `profile updated — ${added} new likes folded in` : "profile up to date");
}

// ---------- seeds ----------
function sampleSeeds(mode, farOut) {
  const p = store.profile;
  let entries;
  if (activeLane && p.lanes?.[activeLane]) {
    entries = Object.entries(p.lanes[activeLane]).map(([k, w]) => [k, Math.max(w, p.artists[k] || 0)]);
  } else {
    entries = Object.entries(p.artists);
  }
  if (!entries.length) return [];
  const topBoost = (k) => (p.top[k] || 0) / 10;
  let pool;
  if (mode === "deep") {
    pool = entries.filter(([k]) => (p.artists[k] || 0) >= 3);
    if (!pool.length) pool = entries.filter(([k]) => (p.artists[k] || 0) >= 2);
    if (!pool.length) pool = entries;
  } else if (Math.random() < farOut) {
    const tail = entries.filter(([k]) => (p.artists[k] || 0) <= 2);
    pool = tail.length >= 5 ? tail : entries;
  } else {
    pool = entries;
  }
  const picks = [];
  const weights = pool.map(([k, c]) => Math.pow(c, 0.7) + topBoost(k));
  const total = weights.reduce((a, b) => a + b, 0);
  const taken = new Set();
  let guard = 0;
  while (picks.length < Math.min(3, pool.length) && guard++ < 50) {
    let r = Math.random() * total;
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) {
        if (!taken.has(i)) { taken.add(i); picks.push(pool[i][0]); }
        break;
      }
    }
  }
  return picks;
}

// ---------- dig ----------
function showDiggingPlaceholder() {
  const grid = $("#grid");
  if (!grid.children.length) grid.append(el("div", "digging", "digging…"));
}

async function runDig(append = false, seedOverride = null, note = "") {
  if (digging) return;
  const mode = $("#modes .on").dataset.mode;
  const manual = seedOverride || $("#seed").value.trim();
  if (mode === "bridge") return runPath("bridge", manual);
  if (mode === "hole") return runPath("hole", manual);
  if (mode === "circling") return runCircling();
  let seeds = manual ? manual.split(",").map((s) => s.trim()).filter(Boolean) : sampleSeeds(mode, sliderVal("farout"));
  if (!seeds.length) {
    status("connect spotify (settings) or type an artist to dig from");
    openSettings();
    return;
  }
  digging = true;
  $("#dig").disabled = true;
  if (!append) {
    closePanel();
    batch = [];
    playedIdx.clear();
    $("#grid").innerHTML = "";
    stopAudio();
    showDiggingPlaceholder();
  }
  status("digging…");
  try {
    const res = await dig(api, {
      mode,
      seeds,
      farOut: sliderVal("farout"),
      obscurity: sliderVal("obscurity"),
      yearCap: mode === "gems" ? parseInt($("#yearcap").value, 10) : null,
      batchSize: 40,
      log: status,
      ...digCallbacks(),
    });
    $("#grid .digging")?.remove();
    const startIdx = batch.length;
    batch = batch.concat(res.tracks);
    renderTracks(res.tracks, startIdx);
    const laneNote = activeLane ? ` · lane: ${activeLane}` : "";
    const listenHint = playedIdx.size ? "" : " · tap any cover to listen";
    status(res.tracks.length
      ? `${batch.length} finds · dug from ${res.seeds.join(", ")}${laneNote}${listenHint}${note ? " · " + note : ""}`
      : "came up empty — try another seed or ease the obscurity dial");
  } catch (e) {
    $("#grid .digging")?.remove();
    status("dig failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// the circling: artists your library surrounds but never picked up
function sampleLibrary(n, laneName = null) {
  const p = store.profile;
  let entries = Object.entries(p.artists);
  const useLane = laneName || activeLane;
  if (useLane && p.lanes?.[useLane]) {
    const lane = p.lanes[useLane];
    const inLane = entries.filter(([k]) => lane[k] !== undefined);
    if (inLane.length >= 5) entries = inLane;
  }
  if (!entries.length) return [];
  const weights = entries.map(([k, c]) => Math.pow(c, 0.6) + (p.top[k] || 0) / 10);
  const total = weights.reduce((a, b) => a + b, 0);
  const picks = new Set();
  let guard = 0;
  while (picks.size < Math.min(n, entries.length) && guard++ < n * 40) {
    let r = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
      r -= weights[i];
      if (r <= 0) { picks.add(entries[i][0]); break; }
    }
  }
  return [...picks];
}

function startWall() {
  closePanel();
  batchHistory.length = 0;
  renderBack();
  batch = [];
  playedIdx.clear();
  $("#grid").innerHTML = "";
  stopAudio();
  showDiggingPlaceholder();
}

function landWall(tracks) {
  $("#grid .digging")?.remove();
  if (!PREVIEW) {
    const now = Date.now();
    for (const t of tracks) if (!store.seen[t.key]) store.seen[t.key] = now;
    persist();
  }
  batch = tracks;
  renderTracks(tracks, 0);
}

function randomLane() {
  const lanes = store.profile.lanes;
  if (!lanes) return null;
  const entries = Object.entries(lanes)
    .map(([name, artists]) => [name, Object.values(artists).reduce((a, b) => a + b, 0)]);
  if (!entries.length) return null;
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[0][0];
}

async function runCircling() {
  if (digging) return;
  // a wide sample of candidate centres; the engine only resolves the few it
  // needs to find a dense corner, so a big list costs nothing
  const lane = activeLane || randomLane();
  const anchors = sampleLibrary(40, lane);
  if (anchors.length < 3) {
    status("circling reads your library — connect spotify in settings first");
    openSettings();
    return;
  }
  digging = true;
  $("#dig").disabled = true;
  startWall();
  try {
    const res = await digCircling(api, {
      libraryArtists: anchors,
      obscurity: sliderVal("obscurity"),
      batchSize: 40,
      log: status,
      ...digCallbacks(),
    });
    landWall(res.tracks);
    status(res.tracks.length
      ? `${res.tracks.length} artists you keep orbiting and never saved · found around ${res.seeds.slice(0, 3).join(", ")}`
      : "no one circling in this corner — dig again, it starts from a different artist each time");
  } catch (e) {
    $("#grid .digging")?.remove();
    status("circling failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// flip the record over: the rest of the label's shelf
async function runLabel(label, skipAlbumId) {
  if (digging || !label) return;
  digging = true;
  $("#dig").disabled = true;
  startWall();
  status(`pulling the ${label} shelf…`);
  try {
    const res = await digLabel(api, {
      label,
      skipAlbumId,
      obscurity: sliderVal("obscurity"),
      batchSize: 40,
      log: status,
      ...digCallbacks(),
    });
    landWall(res.tracks);
    status(res.tracks.length
      ? `${res.tracks.length} more from ${res.label}${res.shelfSize ? ` · ${res.shelfSize} records on that shelf` : ""}`
      : `nothing new on ${label} right now`);
  } catch (e) {
    $("#grid .digging")?.remove();
    status("label dig failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// blindfold: judge by ear, reveal when you save or skip
const revealed = new Set();
const blindOn = () => !!$("#blind")?.checked;
function revealTrack(t, idx) {
  if (!t || revealed.has(t.key)) return;
  revealed.add(t.key);
  tileFor(idx)?.classList.add("revealed");
  if (idx === currentIdx) renderNowbar(t);
}

// pathways: bridge (artist > artist) and rabbit hole (ever more obscure)
function laneTopArtist(laneName, exclude) {
  const lane = store.profile.lanes?.[laneName];
  if (!lane) return null;
  const ranked = Object.entries(lane).sort((a, b) => b[1] - a[1]);
  const hit = ranked.find(([k]) => k !== exclude);
  return hit ? hit[0] : null;
}

async function runPath(kind, manual) {
  if (digging) return;
  let from = null, to = null, seed = null;
  if (kind === "bridge") {
    const parts = manual ? manual.split(/\s*(?:>|->|→)\s*|\s+to\s+/i).map((s) => s.trim()).filter(Boolean) : [];
    if (parts.length >= 2) {
      [from, to] = parts;
    } else if (store.profile.lanes && Object.keys(store.profile.lanes).length >= 2) {
      // blank = bridge across your own map: top artists of two strongest lanes
      const lanes = Object.entries(store.profile.lanes)
        .map(([name, artists]) => [name, Object.values(artists).reduce((a, b) => a + b, 0)])
        .sort((a, b) => b[1] - a[1]);
      from = laneTopArtist(lanes[0][0]);
      to = laneTopArtist(lanes[1][0], from);
    }
    if (!from || !to) {
      status("bridge needs two ends — type: artist > artist");
      return;
    }
  } else {
    seed = manual || sampleSeeds("new", 0.3)[0];
    if (!seed) {
      status("type an artist to descend from, or connect spotify");
      return;
    }
  }
  digging = true;
  $("#dig").disabled = true;
  batch = [];
  playedIdx.clear();
  $("#grid").innerHTML = "";
  stopAudio();
  showDiggingPlaceholder();
  try {
    const res = kind === "bridge"
      ? await digBridge(api, { from, to, obscurity: sliderVal("obscurity"), batchSize: 40, log: status, ...digCallbacks() })
      : await digDescent(api, { seed, obscurity: sliderVal("obscurity"), batchSize: 40, log: status, ...digCallbacks() });
    $("#grid .digging")?.remove();
    if (!PREVIEW) {
      const now = Date.now();
      for (const t of res.tracks) if (!store.seen[t.key]) store.seen[t.key] = now;
      persist();
    }
    batch = res.tracks;
    renderTracks(res.tracks, 0);
    if (!res.tracks.length) {
      status("came up empty — try different ends or ease the obscurity dial");
    } else if (kind === "bridge") {
      status(res.path.length
        ? `bridge: ${res.path.join(" → ")}`
        : `no clean path — mixed digs from ${res.seeds.join(" and ")}`);
    } else {
      status(`rabbit hole: ${res.path.join(" → ")}`);
    }
  } catch (e) {
    $("#grid .digging")?.remove();
    status("path failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// the dive: click a cover → it plays AND the wall becomes its neighborhood.
// The playing track pins itself as tile 0; ← back climbs out.
const batchHistory = [];
function renderBack() {
  const b = $("#backbtn");
  if (b) b.hidden = !batchHistory.length;
}
function goBack() {
  const prev = batchHistory.pop();
  if (!prev) return;
  stopAudio();
  batch = prev;
  playedIdx.clear();
  $("#grid").innerHTML = "";
  renderTracks(prev, 0);
  renderBack();
  status(`${prev.length} finds · stepped back`);
}

async function diveFromTile(idx) {
  const t = batch[idx];
  if (!t) return;
  playIdx(idx); // sound first, always — the dive loads underneath it
  if (digging) return;
  digging = true;
  $("#dig").disabled = true;
  status(`finding songs near “${t.title}”…`);
  try {
    const res = await digNeighbors(api, {
      artist: t.artist,
      title: t.title,
      obscurity: sliderVal("obscurity"),
      batchSize: 24,
      log: () => {},
      ...digCallbacks(),
    });
    const pinned = { ...t };
    const rest = res.tracks.filter((n) => n.key !== pinned.key);
    if (rest.length) {
      if (batch.length) {
        batchHistory.push(batch);
        if (batchHistory.length > 6) batchHistory.shift();
      }
      batch = [pinned, ...rest];
      playedIdx.clear();
      playedIdx.add(0);
      currentIdx = 0;
      $("#grid").innerHTML = "";
      renderTracks(batch, 0);
      tileFor(0)?.classList.add("playing");
      if (!PREVIEW) {
        const now = Date.now();
        for (const n of rest) if (!store.seen[n.key]) store.seen[n.key] = now;
        persist();
      }
      renderBack();
      status(`${batch.length} songs near ${t.artist} — click any cover to keep diving`);
    } else {
      status(`nothing new near ${t.artist} right now — ⤵ tunnels deeper`);
    }
  } catch (e) {
    status("dive failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// ---------- detail panel: the song, its maker, its neighbourhood ----------
let panelSeq = 0;
function closePanel() { $("#panel").hidden = true; }

async function openPanel(idx) {
  const t = batch[idx];
  if (!t) return;
  const seq = ++panelSeq;
  const panel = $("#panel");
  panel.hidden = false;
  panel.scrollTop = 0;
  renderPanelTrack(t);
  $("#p2").replaceChildren(el("div", "ploading", `looking up ${t.artist}…`));
  $("#p3").replaceChildren();
  let data = null;
  try {
    data = await songPanel(api, {
      artist: t.artist,
      title: t.title,
      albumId: t.albumId || null,
      obscurity: sliderVal("obscurity"),
      batchSize: 12,
      ...digCallbacks(),
    });
  } catch (e) {
    if (seq === panelSeq) $("#p2").replaceChildren(el("div", "ploading", "couldn't reach the graph — " + (e.message || e)));
    return;
  }
  if (seq !== panelSeq || panel.hidden) return; // superseded by a later click
  if (!data) { $("#p2").replaceChildren(el("div", "ploading", "no artist page for this one")); return; }
  renderPanelArtist(data);
  renderPanelSimilar(data);
}

async function panelSave(t, btn) {
  const idx = stageTrack(t);
  await saveTrack(idx);
  if (store.saved[batch[idx].key]) btn.classList.add("done");
}

function playAndPanel(t) {
  const i = stageTrack(t);
  playIdx(i);
  openPanel(i);
}

function renderPanelTrack(t) {
  const c = $("#p1");
  c.replaceChildren();
  const art = el("img", "pbigart");
  art.src = t.art;
  art.alt = "";
  art.addEventListener("click", () => playIdx(stageTrack(t)));
  c.append(art, el("div", "ptitle", t.title),
    el("div", "psub", t.artist + (t.album ? " — " + t.album : "") + (t.year ? " · " + t.year : "")));
  if (t.via) c.append(el("div", "pvia", "via " + t.via));

  const acts = el("div", "pacts");
  const mk = (label, cls, fn) => {
    const b = el("button", cls, label);
    b.addEventListener("click", fn);
    acts.append(b);
    return b;
  };
  mk("play", "primary", () => playIdx(stageTrack(t)));
  const love = mk("♥ save", store.saved[t.key] ? "done" : "", () => panelSave(t, love));
  mk("explore this corner", "", () => { closePanel(); diveFromTile(stageTrack(t)); });
  mk("queue", "", () => queueTrack(stageTrack(t)));
  mk("open in spotify", "", () => openInSpotify(stageTrack(t)));
  c.append(acts);

  c.append(el("h4", "", "make a set from this"));
  const set = el("div", "pset");
  for (const [label, size] of [["short · 12", 12], ["medium · 25", 25], ["long · 50", 50]]) {
    const b = el("button", "", label);
    b.addEventListener("click", () => makeSet(t, size));
    set.append(b);
  }
  c.append(set);
}

function renderPanelArtist(data) {
  const { artist, top, related, release } = data;
  const c = $("#p2");
  c.replaceChildren();

  // the record itself — and the shelf it came off
  if (release && (release.label || release.year)) {
    c.append(el("h4", "", "the record"));
    c.append(el("div", "psub", [release.title, release.year, release.label].filter(Boolean).join(" · ")));
    if (release.label) {
      const acts = el("div", "pacts");
      const b = el("button", "", `more on ${release.label}`);
      b.addEventListener("click", () => runLabel(release.label, release.id));
      acts.append(b);
      c.append(acts);
    }
  }

  c.append(el("h4", "", "the artist"));

  const head = el("div", "partist");
  const pic = el("img");
  pic.src = artist.picture_big || artist.picture_medium || "";
  pic.alt = "";
  const meta = el("div");
  meta.append(el("div", "pname", artist.name));
  const bits = [];
  if (artist.nb_fan) bits.push(artist.nb_fan.toLocaleString() + " fans");
  if (artist.nb_album) bits.push(artist.nb_album + " releases");
  meta.append(el("div", "pfans", bits.join(" · ")));
  head.append(pic, meta);
  c.append(head);

  if (top.length) {
    c.append(el("h4", "", "top tracks"));
    const row = el("div", "prow");
    for (const t of top) {
      const im = el("img");
      im.src = t.art;
      im.alt = "";
      im.title = t.title;
      im.addEventListener("click", () => playAndPanel(t));
      row.append(im);
    }
    c.append(row);
  }

  if (related.length) {
    c.append(el("h4", "", "related artists"));
    const grid = el("div", "prelated");
    for (const r of related.slice(0, 8)) {
      const fig = el("figure");
      const im = el("img");
      im.src = r.picture_medium || r.picture_big || "";
      im.alt = "";
      fig.append(im, el("figcaption", "", r.name));
      fig.title = "dig from " + r.name;
      fig.addEventListener("click", () => {
        closePanel();
        $("#seed").value = r.name;
        batchHistory.length = 0;
        renderBack();
        runDig(false, r.name);
      });
      grid.append(fig);
    }
    c.append(grid);
  }
}

function renderPanelSimilar(data) {
  const c = $("#p3");
  c.replaceChildren(el("h4", "", "songs like this"));
  if (!data.similar.length) {
    c.append(el("div", "ploading", "nothing fresh nearby right now — ease the obscure dial"));
    return;
  }
  for (const t of data.similar) {
    const row = el("div", "psong");
    const im = el("img");
    im.src = t.art;
    im.alt = "";
    im.loading = "lazy";
    const m = el("div", "pmeta");
    m.append(el("div", "pt", t.title), el("div", "pa", t.artist + (t.year ? " · " + t.year : "")));
    const love = el("button", "plove" + (store.saved[t.key] ? " done" : ""), "♥");
    love.title = "save to spotify";
    love.addEventListener("click", (e) => { e.stopPropagation(); panelSave(t, love); });
    row.append(im, m, love);
    row.addEventListener("click", () => playAndPanel(t));
    c.append(row);
  }
}

// a set as a journey: the song you liked opens it, then it walks outward
async function makeSet(t, size) {
  if (digging) return;
  digging = true;
  $("#dig").disabled = true;
  closePanel();
  batchHistory.length = 0;
  renderBack();
  batch = [];
  playedIdx.clear();
  $("#grid").innerHTML = "";
  stopAudio();
  showDiggingPlaceholder();
  status(`building a ${size}-song set from “${t.title}”…`);
  try {
    const res = await buildPlaylist(api, {
      artist: t.artist,
      title: t.title,
      size,
      obscurity: sliderVal("obscurity"),
      log: status,
      ...digCallbacks(),
    });
    $("#grid .digging")?.remove();
    const seed = { ...t, via: `${t.artist} — where it starts` };
    const tracks = [seed, ...res.tracks.filter((x) => x.key !== seed.key)].slice(0, size);
    batch = tracks;
    renderTracks(tracks, 0);
    if (!PREVIEW) {
      const now = Date.now();
      for (const x of tracks) if (!store.seen[x.key]) store.seen[x.key] = now;
      persist();
    }
    status(`${tracks.length}-song set out from ${t.artist} — flick drift to play it through`);
    if (store.spotify.tokens) {
      showStatusAction("save this set to spotify", () => saveSetToSpotify(tracks, res.name));
    }
  } catch (e) {
    $("#grid .digging")?.remove();
    status("set failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

async function saveSetToSpotify(tracks, name) {
  if (!store.spotify.tokens) { status("connect spotify first"); return; }
  status(`matching ${tracks.length} songs on spotify…`);
  const uris = [];
  let missing = 0;
  for (const t of tracks) {
    try {
      const hit = await mapToSpotify(t);
      if (hit) uris.push("spotify:track:" + hit.id);
      else missing++;
    } catch { missing++; }
  }
  if (!uris.length) { status("none of these exist on spotify"); return; }
  try {
    const pl = await sp(`/users/${encodeURIComponent(store.spotify.userId)}/playlists`, {
      method: "POST",
      body: JSON.stringify({ name: name || "crate set", public: false, description: "dug up by crate" }),
    });
    for (let i = 0; i < uris.length; i += 100) {
      await sp(`/playlists/${pl.id}/tracks`, {
        method: "POST",
        body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
      });
    }
    status(`saved to spotify: ${name} · ${uris.length} songs${missing ? ` (${missing} weren't there)` : ""}`);
    showStatusAction("open it", () => window.open("https://open.spotify.com/playlist/" + pl.id));
  } catch (e) {
    status("playlist failed — " + e.message);
  }
}

// song → song tunnel from one tile
async function digFromTile(idx) {
  const t = batch[idx];
  if (!t || digging) return;
  digging = true;
  $("#dig").disabled = true;
  stopAudio();
  batch = [];
  playedIdx.clear();
  $("#grid").innerHTML = "";
  showDiggingPlaceholder();
  status(`tunneling from “${t.title}”…`);
  try {
    const res = await digFromTrack(api, {
      artist: t.artist,
      title: t.title,
      obscurity: sliderVal("obscurity"),
      batchSize: 40,
      log: status,
      ...digCallbacks(),
    });
    $("#grid .digging")?.remove();
    batch = res.tracks;
    renderTracks(res.tracks, 0);
    status(res.tracks.length
      ? `${res.tracks.length} finds · tunneled from ${res.seeds[0]}`
      : "tunnel came up empty — try digging from the artist instead");
  } catch (e) {
    $("#grid .digging")?.remove();
    status("tunnel failed — " + (e.message || e));
  }
  digging = false;
  $("#dig").disabled = false;
}

// ---------- grid ----------
// a tile counts as "seen" only after it's actually been on screen for a beat
const seenIO = typeof IntersectionObserver !== "undefined"
  ? new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) { clearTimeout(en.target._seenT); continue; }
        en.target._seenT = setTimeout(() => {
          const t = batch[+en.target.dataset.idx];
          if (t && !PREVIEW && !store.seen[t.key]) { store.seen[t.key] = Date.now(); persist(); }
          seenIO.unobserve(en.target);
        }, 1200);
      }
    }, { threshold: 0.6 })
  : null;

function renderTracks(tracks, startIdx) {
  const grid = $("#grid");
  tracks.forEach((t, i) => {
    const idx = startIdx + i;
    const tile = el("div", "tile");
    tile.dataset.idx = idx;
    if (revealed.has(t.key)) tile.classList.add("revealed");
    if (t.via) tile.title = "via " + t.via;
    const img = el("img");
    img.loading = "lazy";
    img.src = t.art;
    img.alt = "";
    const meta = el("div", "meta");
    meta.append(el("div", "t", t.title), el("div", "a", t.artist + (t.year ? " · " + t.year : "")));
    const acts = el("div", "acts");
    const love = el("button", "love", "♥");
    love.title = "save to spotify (L)";
    const tunnel = el("button", "tunnel", "↓"); // Space Grotesk has no ⤵
    tunnel.title = "dig from this track (D)";
    const ban = el("button", "ban", "✕");
    ban.title = "never show again (X)";
    acts.append(love, tunnel, ban);
    const prog = el("div", "prog");
    const art = el("div", "art");
    art.append(img, acts, prog);
    tile.append(art, meta);
    grid.append(tile);
    seenIO?.observe(tile);

    // a cover plays the song and opens its page — the wall stays behind it
    img.addEventListener("click", () => {
      if (currentIdx === idx && !audio.paused) { pauseAudio(); return; }
      playIdx(idx);
      openPanel(idx);
    });
    img.addEventListener("mouseenter", () => {
      // hover only ever previews — full plays are deliberate taps
      if (store.settings.hoverPlay && userInteracted && !$("#fullplay")?.checked) playIdx(idx);
    });
    love.addEventListener("click", (e) => { e.stopPropagation(); saveTrack(idx); });
    tunnel.addEventListener("click", (e) => { e.stopPropagation(); digFromTile(idx); });
    ban.addEventListener("click", (e) => { e.stopPropagation(); banTrack(idx); });
  });
}

function tileFor(idx) {
  return $(`.tile[data-idx="${idx}"]`);
}

// Tracks that live in the panel (top tracks, neighbours) get an index in
// `batch` without a tile, so every existing action — play, ♥, ban, queue,
// drift — works on them unchanged.
function stageTrack(t) {
  const key = t.key || normKey(t.artist, t.title);
  const found = batch.findIndex((b) => b.key === key);
  if (found >= 0) return found;
  batch.push({ ...t, key });
  return batch.length - 1;
}

// ---------- audio ----------
let userInteracted = false;
window.addEventListener("pointerdown", () => { userInteracted = true; }, { once: true });

function playIdx(idx) {
  const t = batch[idx];
  if (!t) return;
  if ($("#fullplay")?.checked && store.spotify.tokens) return playFull(idx);
  playPreview(idx);
}

// the always-works path: 30s preview right here in the page
function playPreview(idx) {
  const t = batch[idx];
  if (!t || !t.preview) return;
  document.querySelectorAll(".tile.playing").forEach((n) => n.classList.remove("playing"));
  currentIdx = idx;
  playedIdx.add(idx);
  if (!PREVIEW && !store.seen[t.key]) { store.seen[t.key] = Date.now(); persist(); }
  const tile = tileFor(idx);
  if (tile) tile.classList.add("playing");
  audio.src = t.preview;
  audio.play().catch(() => status("tap once more and it'll play"));
  renderNowbar(t);
}

// full-track mode: crate is the remote, your Spotify app (car, speakers,
// desktop — whatever device is active) does the playing. If Spotify can't
// take the handoff, fall back to the preview — a tap must always make sound.
async function playFull(idx) {
  const t = batch[idx];
  if (!t) return;
  status(`sending to spotify: ${t.title}…`);
  try {
    const hit = await mapToSpotify(t);
    if (!hit) {
      playPreview(idx);
      status(`not on spotify — playing the preview: ${t.title}`);
      return;
    }
    await sp("/me/player/play", { method: "PUT", body: JSON.stringify({ uris: ["spotify:track:" + hit.id] }) });
    document.querySelectorAll(".tile.playing").forEach((n) => n.classList.remove("playing"));
    audio.pause();
    currentIdx = idx;
    playedIdx.add(idx);
    if (!PREVIEW && !store.seen[t.key]) { store.seen[t.key] = Date.now(); persist(); }
    tileFor(idx)?.classList.add("playing");
    renderNowbar(t, "playing full in your spotify");
    status(`playing in spotify: ${t.artist} — ${t.title}`);
  } catch (e) {
    const m = e.message || "";
    playPreview(idx);
    if (m.includes("404")) status("spotify app isn't active — playing the 30s preview here instead");
    else if (m.includes("403")) status("playing preview — reconnect spotify (settings) to enable full tracks");
    else status("playing preview — spotify handoff failed: " + m);
  }
}

function pauseAudio() { audio.pause(); }
function stopAudio() {
  audio.pause();
  audio.removeAttribute("src");
  currentIdx = -1;
  $("#nowbar").hidden = true;
  document.querySelectorAll(".tile.playing").forEach((n) => n.classList.remove("playing"));
}

audio.addEventListener("timeupdate", () => {
  const tile = tileFor(currentIdx);
  if (tile && audio.duration) tile.querySelector(".prog").style.width = (audio.currentTime / audio.duration) * 100 + "%";
  const bar = $("#nowprog");
  if (bar && audio.duration) bar.style.width = (audio.currentTime / audio.duration) * 100 + "%";
});

// drift: chain through the batch by provenance, then re-dig onward
function nextDriftIdx() {
  const cur = batch[currentIdx];
  const root = (t) => (t?.via || "").split("→")[0].trim();
  const open = [];
  for (let i = 0; i < batch.length; i++) {
    if (playedIdx.has(i)) continue;
    const t = batch[i];
    if (!t || !t.preview || store.banned[t.key]) continue;
    if (!tileFor(i)) continue; // staged panel tracks aren't part of the drift
    open.push(i);
  }
  if (!open.length) return -1;
  const sameBranch = open.filter((i) => root(batch[i]) && root(batch[i]) === root(cur));
  return (sameBranch.length ? sameBranch : open)[0];
}

audio.addEventListener("ended", () => {
  if (!$("#drift").checked) return;
  const next = nextDriftIdx();
  const openCount = batch.length - playedIdx.size;
  if (openCount <= 6 && !digging) {
    const t = batch[currentIdx];
    runDig(true, t ? t.artist : null); // keep the crate full, onward from here
  }
  if (next >= 0) playIdx(next);
});

function renderNowbar(t, note = "") {
  const bar = $("#nowbar");
  bar.hidden = false;
  $("#nowart").src = t.art;
  const hidden = blindOn() && !revealed.has(t.key);
  bar.classList.toggle("blind", hidden);
  if (hidden) {
    $("#nowtitle").textContent = "———";
    $("#nowsub").textContent = "blindfolded · save or skip to see what it is";
    $("#nowlove").classList.remove("done");
    $("#nowprog").style.width = "0%";
    return;
  }
  $("#nowtitle").textContent = t.title;
  const via = t.via ? ` · via ${t.via}` : "";
  $("#nowsub").textContent = t.artist + (t.album ? " — " + t.album : "") + (t.year ? " · " + t.year : "") + via + (note ? " · " + note : "");
  const saved = store.saved[t.key];
  $("#nowlove").classList.toggle("done", !!saved);
  $("#nowprog").style.width = "0%";
}

// ---------- actions ----------
async function mapToSpotify(t) {
  let isrc = t.isrc;
  if (!isrc) {
    try {
      const full = await api.dz(`track/${t.dzId}`);
      isrc = full?.isrc || null;
      t.isrc = isrc;
    } catch {}
  }
  if (isrc) {
    try {
      const r = await sp(`/search?q=${encodeURIComponent("isrc:" + isrc)}&type=track&limit=1`);
      const hit = r.tracks?.items?.[0];
      if (hit) return hit;
    } catch {}
  }
  const q = `track:"${t.title}" artist:"${t.artist}"`;
  const r = await sp(`/search?q=${encodeURIComponent(q)}&type=track&limit=5`);
  const items = r.tracks?.items || [];
  return items.find((it) => normKey(it.artists?.[0]?.name, it.name) === t.key && Math.abs(it.duration_ms / 1000 - t.duration) < 5)
    || items.find((it) => normKey(it.artists?.[0]?.name, it.name) === t.key)
    || items[0]
    || null;
}

// where ♥ lands besides Liked Songs: "crate" = auto "Crate finds" playlist,
// "none" = liked only, anything else = one of the user's own playlist ids
async function destPlaylistId() {
  const mode = store.settings.playlistMode || "crate";
  if (mode === "none") return null;
  if (mode !== "crate") return mode;
  if (store.settings.playlistId) return store.settings.playlistId;
  const pl = await sp(`/users/${encodeURIComponent(store.spotify.userId)}/playlists`, {
    method: "POST",
    body: JSON.stringify({ name: "Crate finds", public: false, description: "dug up by crate, not an algorithm with a marketing budget" }),
  });
  store.settings.playlistId = pl.id;
  persist();
  return pl.id;
}

function logFind(t, spotifyId) {
  store.finds.unshift({
    key: t.key, ts: Date.now(), spotifyId: spotifyId || null,
    title: t.title, artist: t.artist, album: t.album || "", year: t.year || null, art: t.art || "",
  });
  if (store.finds.length > 400) store.finds.length = 400;
}

async function saveTrack(idx) {
  const t = batch[idx];
  if (!t || store.saved[t.key]) return;
  revealTrack(t, idx);
  const tile = tileFor(idx);
  if (!store.spotify.tokens) {
    store.savedLocal.push({ ...t, ts: Date.now() });
    store.saved[t.key] = { ts: Date.now(), spotifyId: null };
    logFind(t, null);
    persist();
    tile?.querySelector(".love").classList.add("done");
    status(`kept locally (no spotify connected): ${t.artist} — ${t.title}`);
    return;
  }
  status(`saving ${t.title}…`);
  try {
    const hit = await mapToSpotify(t);
    if (hit) {
      await sp(`/me/tracks?ids=${hit.id}`, { method: "PUT", body: JSON.stringify({ ids: [hit.id] }) });
      try {
        const plId = await destPlaylistId();
        if (plId) await sp(`/playlists/${plId}/tracks`, { method: "POST", body: JSON.stringify({ uris: ["spotify:track:" + hit.id] }) });
      } catch (e) {
        status(`liked, but playlist add failed — ${e.message}`);
      }
      store.saved[t.key] = { ts: Date.now(), spotifyId: hit.id };
      logFind(t, hit.id);
      // fold into profile immediately so the next dig knows
      const ak = artistKey(t.artist);
      store.profile.artists[ak] = (store.profile.artists[ak] || 0) + 1;
      trackKeySet.add(t.key);
      store.profile.trackKeys.push(t.key);
      status(`saved: ${t.artist} — ${t.title}`);
    } else {
      store.savedLocal.push({ ...t, ts: Date.now() });
      store.saved[t.key] = { ts: Date.now(), spotifyId: null };
      logFind(t, null);
      status(`not on spotify — kept in the local log: ${t.artist} — ${t.title}`);
    }
    persist();
    tile?.querySelector(".love").classList.add("done");
    if (idx === currentIdx) $("#nowlove").classList.add("done");
  } catch (e) {
    status("save failed — " + e.message);
  }
}

function banTrack(idx) {
  const t = batch[idx];
  if (!t) return;
  revealTrack(t, idx);
  store.banned[t.key] = Date.now();
  persist();
  const tile = tileFor(idx);
  if (tile) tile.classList.add("gone");
  if (idx === currentIdx) {
    if ($("#drift").checked) {
      const next = nextDriftIdx();
      if (next >= 0) { playIdx(next); return; }
    }
    stopAudio();
  }
}

async function queueTrack(idx) {
  const t = batch[idx];
  if (!t) return;
  if (!store.spotify.tokens) { status("connect spotify to queue the full track"); return; }
  status("queueing…");
  try {
    const hit = await mapToSpotify(t);
    if (!hit) { status(`not on spotify — can't queue: ${t.title}`); return; }
    await sp(`/me/player/queue?uri=${encodeURIComponent("spotify:track:" + hit.id)}`, { method: "POST" });
    status(`queued on spotify: ${t.artist} — ${t.title}`);
  } catch (e) {
    const m = e.message || "";
    if (m.includes("403")) status("reconnect spotify (settings → connect) once to enable queueing");
    else if (m.includes("404")) status("no active spotify device — start playback anywhere first, then queue");
    else status("queue failed — " + m);
  }
}

async function openInSpotify(idx) {
  const t = batch[idx];
  if (!t) return;
  const saved = store.saved[t.key];
  if (saved?.spotifyId) return window.open("https://open.spotify.com/track/" + saved.spotifyId);
  if (store.spotify.tokens) {
    try {
      const hit = await mapToSpotify(t);
      if (hit) return window.open("https://open.spotify.com/track/" + hit.id);
    } catch {}
  }
  window.open("https://open.spotify.com/search/" + encodeURIComponent(t.artist + " " + t.title));
}

// ---------- settings ----------
function openSettings() { $("#setup").hidden = false; $("#profile").hidden = true; populatePlaylistPicker(); }
function closeSettings() { $("#setup").hidden = true; }

async function populatePlaylistPicker() {
  const sel = $("#pldest");
  if (!sel || sel.dataset.loaded) return;
  const mode = store.settings.playlistMode || "crate";
  const opt = (value, label) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = label;
    if (value === mode) o.selected = true;
    sel.append(o);
  };
  sel.innerHTML = "";
  opt("crate", "Crate finds (auto)");
  opt("none", "liked songs only");
  if (store.spotify.tokens) {
    try {
      const r = await sp("/me/playlists?limit=50");
      for (const pl of r.items || []) {
        if (pl.owner?.id === store.spotify.userId || pl.collaborative) opt(pl.id, pl.name);
      }
      sel.dataset.loaded = "1";
    } catch {
      // old token without playlist-read scope — picker works after a reconnect
    }
  }
}

function bindSettings() {
  $("#clientid").value = store.spotify.clientId || "";
  $("#opthover").checked = !!store.settings.hoverPlay;
  const ruri = $("#ruri");
  if (ruri) ruri.textContent = REDIRECT_URI;

  $("#savesetup").addEventListener("click", async () => {
    store.spotify.clientId = $("#clientid").value.trim();
    store.settings.playlistMode = $("#pldest").value || "crate";
    store.settings.playlist = store.settings.playlistMode !== "none";
    store.settings.hoverPlay = $("#opthover").checked;
    await persist(true);
    status("saved");
  });
  $("#connect").addEventListener("click", login);
  $("#rescan").addEventListener("click", () => { closeSettings(); scanLibrary(false); });
  $("#fullrescan").addEventListener("click", () => { closeSettings(); scanLibrary(true); });
  $("#disconnect").addEventListener("click", async () => {
    store.spotify.tokens = null;
    await persist(true);
    renderStatusLine();
    status("disconnected");
  });
  $("#closesetup").addEventListener("click", closeSettings);
}

function renderStatusLine() {
  const p = store.profile;
  const who = store.spotify.tokens ? (store.spotify.userName || "connected") : "not connected";
  $("#acct").textContent = p.count
    ? `${who} · ${p.count.toLocaleString()} liked songs`
    : who;
}

// ---------- profile ----------
const ago = (ts) => {
  const d = Math.floor((Date.now() - ts) / 86400000);
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
};

function openProfile() { $("#profile").hidden = false; $("#setup").hidden = true; renderProfile(); }
function closeProfile() { $("#profile").hidden = true; }

function renderProfile() {
  const p = store.profile;
  $("#profwho").textContent = store.spotify.userName ? `${store.spotify.userName}'s crate` : "your crate";

  // one honest line about the shape of the library
  const years = Object.entries(p.years || {}).map(([y, n]) => [+y, n]).sort((a, b) => a[0] - b[0]);
  let vintage = "";
  if (years.length > 3) {
    const total = years.reduce((s, [, n]) => s + n, 0);
    let acc = 0, lo = years[0][0], hi = years[years.length - 1][0];
    for (const [y, n] of years) { acc += n; if (acc / total > 0.25) { lo = y; break; } }
    acc = 0;
    for (let i = years.length - 1; i >= 0; i--) { acc += years[i][1]; if (acc / total > 0.25) { hi = years[i][0]; break; } }
    vintage = ` · the heart of it lives ${Math.min(lo, hi)}–${Math.max(lo, hi)}, oldest corners reach ${years[0][0]}`;
  }
  $("#profstats").textContent =
    `${(p.count || 0).toLocaleString()} liked songs · ${Object.keys(p.artists || {}).length.toLocaleString()} artists` +
    `${vintage} · ${store.finds.length} finds dug so far`;

  // lanes, ranked
  const lanesEl = $("#proflanes");
  lanesEl.innerHTML = "";
  const lanes = p.lanes ? Object.entries(p.lanes)
    .map(([name, artists]) => [name, Object.values(artists).reduce((a, b) => a + b, 0)])
    .sort((a, b) => b[1] - a[1]) : [];
  const laneMax = lanes[0]?.[1] || 1;
  for (const [name, w] of lanes.slice(0, 8)) {
    const li = el("li");
    const bar = el("span", "bar");
    bar.style.width = Math.max(6, (w / laneMax) * 100) + "%";
    li.append(el("span", "lbl", name), bar);
    lanesEl.append(li);
  }
  if (!lanes.length) lanesEl.append(el("li", "empty", "lanes appear after a scan (reconnect + reload)"));

  // most-dug artists: library weight + listening rank
  const artistsEl = $("#profartists");
  artistsEl.innerHTML = "";
  const ranked = Object.entries(p.artists || {})
    .map(([k, c]) => [k, c + (p.top[k] || 0) / 5])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  for (const [name] of ranked) artistsEl.append(el("li", "", name));

  // the finds log
  $("#findcount").textContent = store.finds.length ? `· ${store.finds.length}` : "";
  const list = $("#findslist");
  list.innerHTML = "";
  if (!store.finds.length) {
    list.append(el("div", "empty", "nothing logged yet — ♥ a find and it lands here (and in your spotify likes)"));
  }
  for (const f of store.finds.slice(0, 120)) {
    const row = el("div", "find");
    const img = el("img");
    img.src = f.art; img.loading = "lazy"; img.alt = "";
    const meta = el("div", "fmeta");
    meta.append(
      el("div", "ft", f.title),
      el("div", "fa", f.artist + (f.year ? " · " + f.year : "") + (f.spotifyId ? "" : " · not on spotify"))
    );
    const when = el("span", "fwhen", ago(f.ts));
    const open = el("a", "fopen", "open");
    open.href = f.spotifyId
      ? "https://open.spotify.com/track/" + f.spotifyId
      : "https://open.spotify.com/search/" + encodeURIComponent(f.artist + " " + f.title);
    open.target = "_blank";
    row.append(img, meta, when, open);
    list.append(row);
  }
}

// the discoverquickly move: bottle recent finds into a fresh playlist
async function makePlaylistFromFinds() {
  if (!store.spotify.tokens) { status("connect spotify first"); return; }
  const ids = store.finds.filter((f) => f.spotifyId).slice(0, 100).map((f) => f.spotifyId);
  if (!ids.length) { status("no spotify-matched finds to bottle yet — ♥ some first"); return; }
  const name = $("#plname").value.trim() || "crate · " + new Date().toISOString().slice(0, 10);
  const btn = $("#mkpl");
  btn.disabled = true;
  status(`bottling ${ids.length} finds into “${name}”…`);
  try {
    const pl = await sp(`/users/${encodeURIComponent(store.spotify.userId)}/playlists`, {
      method: "POST",
      body: JSON.stringify({ name, public: false, description: "dug up by crate" }),
    });
    await sp(`/playlists/${pl.id}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: ids.map((id) => "spotify:track:" + id) }),
    });
    status(`playlist made: ${name} — ${ids.length} tracks`);
    window.open("https://open.spotify.com/playlist/" + pl.id);
  } catch (e) {
    status("playlist failed — " + e.message);
  }
  btn.disabled = false;
}

// ---------- controls ----------
function sliderVal(id) { return parseInt($("#" + id).value, 10) / 100; }

function bindControls() {
  $("#dig").addEventListener("click", () => { batchHistory.length = 0; renderBack(); runDig(false); });
  $("#backbtn")?.addEventListener("click", goBack);
  $("#seed").addEventListener("keydown", (e) => { if (e.key === "Enter") { batchHistory.length = 0; renderBack(); runDig(false); } });
  const PLACEHOLDERS = {
    bridge: "artist > artist (blank = across your lanes)",
    hole: "start artist… (blank = your taste)",
    circling: "circling reads your whole library — just hit dig",
  };
  for (const b of $("#modes").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      $("#modes .on")?.classList.remove("on");
      b.classList.add("on");
      $("#yearwrap").hidden = b.dataset.mode !== "gems";
      $("#seed").placeholder = PLACEHOLDERS[b.dataset.mode] || "dig from an artist… (blank = your taste)";
      // the controls ARE the view: switching mode reshapes the wall right now
      batchHistory.length = 0;
      renderBack();
      runDig(false);
    });
  }
  // …and so does releasing a dial or changing the year cap
  for (const id of ["farout", "obscurity", "yearcap"]) {
    $("#" + id)?.addEventListener("change", () => runDig(false));
  }
  $("#gear").addEventListener("click", () => ($("#setup").hidden ? openSettings() : closeSettings()));
  $("#panelclose")?.addEventListener("click", closePanel);
  $("#statusact")?.addEventListener("click", () => statusActFn && statusActFn());
  const fp = $("#fullplay");
  if (fp) {
    fp.checked = !!store.settings.fullPlay;
    fp.addEventListener("change", () => { store.settings.fullPlay = fp.checked; persist(); });
  }
  const bl = $("#blind");
  if (bl) {
    bl.checked = !!store.settings.blindfold;
    $("#grid").classList.toggle("blind", bl.checked);
    bl.addEventListener("change", () => {
      store.settings.blindfold = bl.checked;
      persist();
      $("#grid").classList.toggle("blind", bl.checked);
      if (currentIdx >= 0 && batch[currentIdx]) renderNowbar(batch[currentIdx]);
    });
  }
  $("#prof")?.addEventListener("click", () => ($("#profile").hidden ? openProfile() : closeProfile()));
  $("#closeprofile")?.addEventListener("click", closeProfile);
  $("#mkpl")?.addEventListener("click", makePlaylistFromFinds);

  $("#nowlove").addEventListener("click", () => saveTrack(currentIdx));
  $("#nowban").addEventListener("click", () => banTrack(currentIdx));
  $("#nowqueue")?.addEventListener("click", () => queueTrack(currentIdx));
  $("#nowopen").addEventListener("click", () => openInSpotify(currentIdx));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePanel(); return; }
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    if (e.code === "Space") { e.preventDefault(); audio.paused ? audio.play().catch(() => {}) : audio.pause(); }
    if (e.key === "i") openPanel(currentIdx);
    if (e.key === "n") playIdx(Math.min(currentIdx + 1, batch.length - 1));
    if (e.key === "p") playIdx(Math.max(currentIdx - 1, 0));
    if (e.key === "l") saveTrack(currentIdx);
    if (e.key === "x") banTrack(currentIdx);
    if (e.key === "d") digFromTile(currentIdx);
    if (e.key === "q") queueTrack(currentIdx);
  });
}

// ---------- boot ----------
(async function boot() {
  await loadStore();
  bindSettings();
  bindControls();

  if (location.pathname === "/callback") {
    await handleCallback();
  }

  renderStatusLine();
  renderLanes();

  const params = new URLSearchParams(location.search);
  const demoSeed = params.get("demo");
  if (params.get("panel") === "profile") openProfile();

  if (demoSeed) {
    $("#seed").value = demoSeed;
    if (params.get("autodig")) runDig(false);
  } else if (store.spotify.tokens) {
    // connected: keep the profile + lanes fresh, then open straight into a dig
    const digIfIdle = () => { if (!batch.length && !digging && store.profile.count) runDig(false); };
    const needScan = Date.now() - (store.profile.builtAt || 0) > 24 * 3600 * 1000;
    if (!PREVIEW && needScan) {
      scanLibrary(false).then(digIfIdle);
    } else if (!store.profile.lanes) {
      scanTopAndLanes(!PREVIEW).then(digIfIdle);
    } else {
      digIfIdle();
    }
  } else if (!store.profile.count) {
    // fresh crate: open into music, not a form
    const STARTERS = [
      "Radiohead", "J Dilla", "Aphex Twin", "Portishead", "Fela Kuti",
      "Cocteau Twins", "Boards of Canada", "Miles Davis", "Talking Heads",
      "MF DOOM", "Brian Eno", "Massive Attack", "Stereolab", "Madlib", "Sade",
    ];
    const pick = STARTERS[Math.floor(Math.random() * STARTERS.length)];
    runDig(false, pick, "connect spotify (settings) to dig from your own taste");
  }
})();
