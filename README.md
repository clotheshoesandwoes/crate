# crate

Local music discovery that digs instead of pushing. Your Spotify library is the
taste profile; the recommendations come from open similarity graphs (Deezer,
optionally Last.fm) — not from Spotify's promo pipeline. Runs entirely on your
machine at `http://127.0.0.1:8823`.

![crate — a dig seeded from Madlib](docs/screenshot.png)

Why not just use Spotify's recommendations API? Because it's gone — Spotify
removed `/recommendations`, related-artists, and audio-features for all new
apps in November 2024. crate treats Spotify as a dumb library (read likes,
save finds back) and gets everything else elsewhere.

## Run

Double-click `crate.vbs` (hidden console) or `start.cmd` (visible console).
Needs Node, no npm install.

## One-time setup (~3 minutes)

1. Open <https://developer.spotify.com/dashboard>, log in with your normal
   Spotify account, hit **Create app**.
2. Name/description: anything. **Redirect URI**: `http://127.0.0.1:8823/callback`
   (must be exactly this — Spotify requires the 127.0.0.1 form, not localhost).
   Tick **Web API**. Save.
3. Copy the **Client ID** from the app's settings page into crate's settings
   panel, save, then **Connect Spotify**.

First connect scans your Liked Songs (a few minutes if you have thousands;
incremental afterwards) plus your top artists, and stores the profile locally.

Optional: a free [Last.fm API key](https://www.last.fm/api/account/create)
adds a second, community-driven similarity graph on top of Deezer's.

## Use

- **Dig** — fills the grid with ~48 finds. Blank seed = sampled from your
  taste; or type any artist ("dig from…").
- **Modes**: *New* (artists you don't know), *Old gems* (year-capped album
  digs, oldest-first bias), *Deep cuts* (non-hit album tracks from artists you
  already love).
- **Dials**: familiar↔far out (how far the graph walk wanders), popular↔obscure
  (fan-count / rank caps — push it right to escape the mainstream).
- Click a cover to play the 30s preview (hover-to-play can be enabled in
  settings). **Drift** auto-plays onward and re-digs from wherever you drifted
  to when the crate runs low — a shuffle that actually goes somewhere.
- **♥** saves to your Liked Songs + a private *Crate finds* playlist and feeds
  the profile so the next dig knows. **✕** bans a track forever. Everything
  shown is remembered and won't reappear for 14 days.
- Keys: `space` pause · `n`/`p` next/prev · `l` love · `x` ban.

## Files

- `server.js` — zero-dep local server: static UI, Deezer/Last.fm proxy
  (throttled + cached), store persistence. Binds 127.0.0.1 only.
- `public/engine.js` — the discovery engine (graph walk, filtering, scoring).
- `public/app.js` — Spotify PKCE auth, library scan, UI.
- `data/store.json` — your profile, seen/banned/saved log, tokens. Local only;
  delete it to reset everything.
- `check.mjs` — `npm run check`: live end-to-end engine test, no Spotify needed.

Personal-use app (Spotify "development mode", your account only). Tracks that
exist on Deezer but not Spotify are kept in a local log instead of being lost.

---

Built by [Sean Kani](https://seankani.com).
