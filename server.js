// crate — local server: static UI + API proxy (Deezer/Last.fm) + local store.
// Zero dependencies. Binds 127.0.0.1 only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA, "store.json");
const PORT = Number(process.env.PORT || 8823);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------- store ----------
const DEFAULT_STORE = {
  spotify: { clientId: "", tokens: null, userId: "", userName: "" },
  lastfm: { apiKey: "" },
  settings: { playlist: true, playlistId: null, hoverPlay: true },
  profile: { builtAt: 0, newestAddedAt: "", count: 0, artists: {}, top: {}, lanes: null, trackKeys: [], isrcs: [], years: {} },
  seen: {},
  banned: {},
  saved: {},
  savedLocal: [],
};

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { ...structuredClone(DEFAULT_STORE), ...raw };
  } catch {
    return structuredClone(DEFAULT_STORE);
  }
}

function saveStore(obj) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, STORE_FILE);
}

// ---------- upstream proxy: throttle + cache ----------
const cache = new Map(); // key -> { t, body, status }
const CACHE_TTL = 24 * 3600 * 1000;
const CACHE_MAX = 5000;

let nextSlotAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function throttle(spacingMs) {
  const now = Date.now();
  const wait = Math.max(0, nextSlotAt - now);
  nextSlotAt = Math.max(now, nextSlotAt) + spacingMs;
  if (wait) await sleep(wait);
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit;
  if (hit) cache.delete(key);
  return null;
}

function cachePut(key, val) {
  if (cache.size >= CACHE_MAX) {
    // drop oldest ~10%
    const keys = [...cache.keys()].slice(0, Math.ceil(CACHE_MAX / 10));
    for (const k of keys) cache.delete(k);
  }
  cache.set(key, { t: Date.now(), ...val });
}

const DEEZER_OK = /^(search(\/artist|\/track|\/album)?|artist\/\d+(\/related|\/top|\/albums)?|album\/\d+(\/tracks)?|track\/(\d+|isrc:[A-Za-z0-9-]+))$/;

async function proxyDeezer(pathAndQuery) {
  const [p] = pathAndQuery.split("?");
  if (!DEEZER_OK.test(p)) return { status: 400, body: JSON.stringify({ error: "path not allowed" }) };
  const key = "dz:" + pathAndQuery;
  const hit = cacheGet(key);
  if (hit) return hit;
  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle(130);
    let res, text;
    try {
      res = await fetch("https://api.deezer.com/" + pathAndQuery);
      text = await res.text();
    } catch (e) {
      if (attempt === 2) return { status: 502, body: JSON.stringify({ error: String(e) }) };
      await sleep(800);
      continue;
    }
    // Deezer signals quota as 200 + {error:{code:4}}
    let quota = false;
    try {
      const j = JSON.parse(text);
      quota = j && j.error && j.error.code === 4;
    } catch {}
    if (quota) {
      await sleep(1800);
      continue;
    }
    const out = { status: res.status, body: text };
    if (res.status === 200) cachePut(key, out);
    return out;
  }
  return { status: 429, body: JSON.stringify({ error: "deezer quota, gave up" }) };
}

async function proxyLastfm(query, apiKey) {
  if (!apiKey) return { status: 400, body: JSON.stringify({ error: "no last.fm key configured" }) };
  const qs = new URLSearchParams(query);
  qs.set("api_key", apiKey);
  qs.set("format", "json");
  const key = "lf:" + qs.toString();
  const hit = cacheGet(key);
  if (hit) return hit;
  await throttle(220);
  try {
    const res = await fetch("https://ws.audioscrobbler.com/2.0/?" + qs.toString());
    const text = await res.text();
    const out = { status: res.status, body: text };
    if (res.status === 200) cachePut(key, out);
    return out;
  } catch (e) {
    return { status: 502, body: JSON.stringify({ error: String(e) }) };
  }
}

// ---------- http ----------
function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  try {
    if (p === "/api/ping") return send(res, 200, JSON.stringify({ ok: true }));

    if (p.startsWith("/api/deezer/")) {
      const rest = req.url.slice("/api/deezer/".length);
      const out = await proxyDeezer(rest);
      return send(res, out.status, out.body);
    }

    if (p === "/api/lastfm") {
      const store = loadStore();
      const out = await proxyLastfm(url.search.slice(1), store.lastfm.apiKey);
      return send(res, out.status, out.body);
    }

    if (p === "/api/store") {
      if (req.method === "GET") return send(res, 200, JSON.stringify(loadStore()));
      if (req.method === "POST") {
        const body = await readBody(req);
        const obj = JSON.parse(body);
        if (!obj || typeof obj !== "object") return send(res, 400, JSON.stringify({ error: "bad store" }));
        saveStore(obj);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
    }

    // static
    let file = p === "/" || p === "/callback" ? "/index.html" : p;
    file = path.normalize(file).replace(/^([/\\])+/, "");
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB)) return send(res, 403, "forbidden", "text/plain");
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(full).pipe(res);
      return;
    }
    return send(res, 404, "not found", "text/plain");
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e) }));
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`crate is already running at http://127.0.0.1:${PORT}`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`crate → http://127.0.0.1:${PORT}`);
});
