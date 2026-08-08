// crate smoke test — spawns the server, hits live Deezer through the proxy,
// runs the engine end-to-end for all three modes. No Spotify needed.
import { spawn } from "node:child_process";
import { dig } from "./public/engine.js";

const PORT = 8824; // separate from the app so a running instance isn't disturbed
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server.js"], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + "/api/ping");
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("server never came up");
}

const api = {
  dz: async (p) => {
    const j = await (await fetch(BASE + "/api/deezer/" + p)).json();
    if (j && j.error) throw new Error(JSON.stringify(j.error));
    return j;
  },
  lastfm: null,
};

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`${cond ? "ok " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

try {
  await waitUp();

  // raw proxy shape
  const s = await api.dz("search/artist?q=boards%20of%20canada&limit=3");
  check("deezer artist search", s.data?.[0]?.id > 0, s.data?.[0]?.name);
  const aid = s.data[0].id;
  const rel = await api.dz(`artist/${aid}/related?limit=5`);
  check("related artists", rel.data?.length >= 3, (rel.data || []).map((a) => a.name).slice(0, 3).join(", "));
  const top = await api.dz(`artist/${aid}/top?limit=5`);
  check("top tracks have previews", top.data?.some((t) => t.preview), top.data?.[0]?.title);
  const alb = await api.dz(`artist/${aid}/albums?limit=10`);
  check("albums have release dates", alb.data?.some((a) => a.release_date), alb.data?.[0]?.release_date);
  if (alb.data?.[0]) {
    const full = await api.dz(`album/${alb.data[0].id}`);
    check("album embeds tracks", (full.tracks?.data?.length || 0) > 0, `${full.title}: ${full.tracks?.data?.length} tracks`);
  }
  const isrcT = await api.dz(`track/${top.data[0].id}`);
  check("full track has isrc", !!isrcT.isrc, isrcT.isrc);

  // engine, mode: new
  const base = { isKnownArtist: () => 0, hasTrack: () => false, isSeen: () => false, log: () => {} };
  const rNew = await dig(api, { mode: "new", seeds: ["Boards of Canada"], farOut: 0.3, obscurity: 0.6, batchSize: 40, ...base });
  check("new: enough tracks", rNew.tracks.length >= 15, `${rNew.tracks.length} tracks`);
  check("new: all have previews", rNew.tracks.every((t) => t.preview));
  check("new: all have art", rNew.tracks.every((t) => t.art));
  const perArtist = {};
  rNew.tracks.forEach((t) => (perArtist[t.artist] = (perArtist[t.artist] || 0) + 1));
  check("new: diversified", Math.max(...Object.values(perArtist)) <= 2, `${Object.keys(perArtist).length} artists`);
  console.log("     sample:", rNew.tracks.slice(0, 5).map((t) => `${t.artist} — ${t.title}`).join(" | "));

  // engine, mode: gems (year-capped)
  const rGems = await dig(api, { mode: "gems", seeds: ["Portishead"], farOut: 0.3, obscurity: 0.5, yearCap: 2005, batchSize: 30, ...base });
  check("gems: enough tracks", rGems.tracks.length >= 8, `${rGems.tracks.length} tracks`);
  check("gems: respects year cap", rGems.tracks.every((t) => !t.year || t.year <= 2005),
    rGems.tracks.slice(0, 4).map((t) => `${t.artist} ${t.year}`).join(", "));

  // engine, mode: deep (known artists only)
  const known = { boardsofcanada: 10, autechre: 6, "aphex twin": 8 };
  const rDeep = await dig(api, {
    mode: "deep", seeds: ["Autechre"], farOut: 0.2, obscurity: 0.4, batchSize: 30,
    ...base, isKnownArtist: (k) => known[k.replace(/\s/g, "")] || known[k] || 0,
  });
  check("deep: returns tracks", rDeep.tracks.length >= 5, `${rDeep.tracks.length} tracks`);

  // exclusion honored
  const banned = new Set(rNew.tracks.slice(0, 5).map((t) => t.key));
  const rEx = await dig(api, { mode: "new", seeds: ["Boards of Canada"], farOut: 0.3, obscurity: 0.6, batchSize: 40, ...base, isSeen: (k) => banned.has(k) });
  check("seen/banned excluded", rEx.tracks.every((t) => !banned.has(t.key)));
} catch (e) {
  console.error("FAIL crash:", e);
  failures++;
} finally {
  server.kill();
}

console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
