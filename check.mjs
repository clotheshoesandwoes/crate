// crate smoke test — spawns the server, hits live Deezer through the proxy,
// runs the engine end-to-end for all three modes. No Spotify needed.
import { spawn } from "node:child_process";
import {
  dig, digFromTrack, digBridge, digDescent, digNeighbors, songPanel, buildPlaylist,
  digCircling, digLabel,
} from "./public/engine.js";

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
  check("new: enough tracks", rNew.tracks.length >= 12, `${rNew.tracks.length} tracks`);
  check("new: all have previews", rNew.tracks.every((t) => t.preview));
  check("new: all have art", rNew.tracks.every((t) => t.art));
  check("new: all carry provenance", rNew.tracks.every((t) => t.via), rNew.tracks[0]?.via);
  const perArtist = {};
  rNew.tracks.forEach((t) => (perArtist[t.artist] = (perArtist[t.artist] || 0) + 1));
  check("new: one per artist", Math.max(...Object.values(perArtist)) <= 1, `${Object.keys(perArtist).length} artists`);
  const perAlbum = {};
  rNew.tracks.forEach((t) => t.albumId && (perAlbum[t.albumId] = (perAlbum[t.albumId] || 0) + 1));
  check("new: one per album", Math.max(...Object.values(perAlbum), 0) <= 1);
  console.log("     sample:", rNew.tracks.slice(0, 5).map((t) => `${t.artist} — ${t.title}`).join(" | "));

  // song → song tunnel (no last.fm key here → artist-graph fallback path)
  const rTun = await digFromTrack(api, { artist: "Burial", title: "Archangel", obscurity: 0.5, batchSize: 30, ...base });
  check("tunnel: returns tracks", rTun.tracks.length >= 10, `${rTun.tracks.length} tracks`);
  check("tunnel: all carry provenance", rTun.tracks.every((t) => t.via));

  // banned-artist branch burial
  const rPen = await dig(api, {
    mode: "new", seeds: ["Boards of Canada"], farOut: 0.3, obscurity: 0.6, batchSize: 40, ...base,
    artistPenalty: (k) => (k === "aphex twin" ? 0 : 1),
  });
  check("penalty: banned artist excluded", rPen.tracks.every((t) => t.artist.toLowerCase() !== "aphex twin"));

  // engine, mode: gems (year-capped)
  const rGems = await dig(api, { mode: "gems", seeds: ["Portishead"], farOut: 0.3, obscurity: 0.5, yearCap: 2005, batchSize: 30, ...base });
  check("gems: enough tracks", rGems.tracks.length >= 8, `${rGems.tracks.length} tracks`);
  check("gems: respects year cap", rGems.tracks.every((t) => !t.year || t.year <= 2005),
    rGems.tracks.slice(0, 4).map((t) => `${t.artist} ${t.year}`).join(", "));

  // the dive: fast neighborhood of one track
  const rNb = await digNeighbors(api, { artist: "Burial", title: "Archangel", obscurity: 0.5, batchSize: 24, ...base });
  check("dive: tracks", rNb.tracks.length >= 10, `${rNb.tracks.length} tracks`);
  check("dive: provenance", rNb.tracks.every((t) => t.via && t.via.startsWith("near")));

  // the circling: strangers your library surrounds
  const lib = ["Portishead", "Massive Attack", "Tricky", "Burial", "Boards of Canada", "Radiohead"];
  const libSet = new Set(lib.map((s) => s.toLowerCase()));
  const rCirc = await digCircling(api, {
    ...base, libraryArtists: lib, obscurity: 0.5, batchSize: 30,
    isKnownArtist: (k) => (libSet.has(k) ? 5 : 0),
  });
  check("circling: tracks", rCirc.tracks.length >= 8, `${rCirc.tracks.length} tracks`);
  check("circling: never your own artists", rCirc.tracks.every((t) => !libSet.has(t.artist.toLowerCase())));
  check("circling: found multi-orbit strangers", rCirc.orbits.length >= 3, rCirc.orbits.slice(0, 4).join(", "));
  check("circling: provenance names the orbits", rCirc.tracks.every((t) => t.via.startsWith("circling")), rCirc.tracks[0]?.via);

  // the label shelf
  const rLab = await digLabel(api, { ...base, label: "Stones Throw Records", obscurity: 0.5, batchSize: 25 });
  check("label: tracks", rLab.tracks.length >= 8, `${rLab.tracks.length} from ${rLab.label} · shelf ${rLab.shelfSize}`);
  check("label: provenance", rLab.tracks.every((t) => t.via.includes("the label")));
  console.log("     shelf sample:", rLab.tracks.slice(0, 4).map((t) => `${t.artist} — ${t.title}`).join(" | "));

  // panel carries the record's label (that's what makes the shelf dig possible)
  const albumHit = await api.dz("search/album?q=madvillainy&limit=1");
  const panLab = await songPanel(api, { ...base, artist: "Madvillain", title: "Accordion", albumId: albumHit.data[0].id });
  check("panel: reads the label off the record", !!panLab?.release?.label,
    `${panLab?.release?.title} · ${panLab?.release?.year} · ${panLab?.release?.label}`);

  // detail panel: the 1-2-3
  const pan = await songPanel(api, { artist: "Burial", title: "Archangel", obscurity: 0.5, ...base });
  check("panel: artist card", !!pan?.artist?.name && pan.artist.nb_fan > 0,
    `${pan?.artist?.name} · ${pan?.artist?.nb_fan?.toLocaleString()} fans · ${pan?.artist?.nb_album} releases`);
  check("panel: top tracks playable", pan.top.length >= 5 && pan.top.every((t) => t.preview), `${pan.top.length} tracks`);
  check("panel: related artists", pan.related.length >= 6, pan.related.slice(0, 3).map((r) => r.name).join(", "));
  check("panel: songs like this", pan.similar.length >= 6, `${pan.similar.length} songs`);

  // playlists: short / medium / long
  for (const size of [12, 25]) {
    const set = await buildPlaylist(api, { artist: "Portishead", title: "Glory Box", size, obscurity: 0.5, ...base });
    const cap = size <= 12 ? 1 : 2;
    const per = {};
    set.tracks.forEach((t) => (per[t.artist] = (per[t.artist] || 0) + 1));
    check(`set ${size}: length`, set.tracks.length >= size * 0.8, `${set.tracks.length}/${size}`);
    check(`set ${size}: artist cap`, Math.max(...Object.values(per)) <= cap, `max ${Math.max(...Object.values(per))} per artist`);
    check(`set ${size}: journey order`, /where it starts/.test(set.tracks[0]?.via || ""), set.tracks[0]?.via);
  }

  // pathway: bridge between two artists
  const rBr = await digBridge(api, { from: "Portishead", to: "Aphex Twin", obscurity: 0.5, batchSize: 30, ...base });
  check("bridge: tracks", rBr.tracks.length >= 8, `${rBr.tracks.length} tracks`);
  check("bridge: found a path", rBr.path.length >= 3, rBr.path.join(" > "));
  check("bridge: provenance", rBr.tracks.every((t) => t.via));

  // pathway: rabbit hole descends in fan count
  const rHo = await digDescent(api, { seed: "Radiohead", obscurity: 0.6, batchSize: 30, ...base });
  check("hole: tracks", rHo.tracks.length >= 8, `${rHo.tracks.length} tracks`);
  check("hole: goes somewhere", rHo.path.length >= 4, `${rHo.path.length} stops: ${rHo.path.slice(0, 5).join(" > ")}…`);

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
