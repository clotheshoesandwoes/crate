# crate — how it actually works

The one-paragraph version, for telling a friend:

> crate is a crate-digging machine for Spotify. It reads your liked songs to
> learn your taste, then deliberately walks *away* from it — through Deezer's
> public "fans also like" graph, two hops minimum, past the layer where the
> algorithm-friendly hits live — and comes back with a wall of album covers
> you've never seen. Tap one and it plays; tap ♥ and it lands back in your
> Spotify. Spotify killed its recommendations API in late 2024, so crate
> treats Spotify as a dumb record shelf and does the actual discovery on open
> data. No feed, no autoplay slop, no "because you listened to…" — you dig.

## The whole system on one screen

There is no framework, no build step, and no database. `package.json` has
zero dependencies. The entire app is five files of hand-written JavaScript:

```
browser (public/)                      server
┌──────────────────────────────┐      ┌─────────────────────────────┐
│ index.html   one screen      │      │ server.js (local, port 8823)│
│ style.css    the whole look  │ ───► │  · serves public/           │
│ app.js       spotify + UI    │      │  · /api/deezer/* proxy      │
│ engine.js    the dig         │      │    (throttled + 24h cache)  │
└──────────────────────────────┘      │  · /api/store  (store.json) │
        │                             └─────────────────────────────┘
        │                              or, deployed on Vercel:
        │                             ┌─────────────────────────────┐
        └── spotify API directly ───► │ api/deezer/[...path].js     │
            (PKCE, tokens stay        │  · same proxy, edge-cached  │
             client-side)             │  · store → localStorage     │
                                      └─────────────────────────────┘
```

Same static frontend in both cases. `app.js:8` checks the hostname: on
`127.0.0.1`/`localhost` the profile/tokens persist to `data/store.json`
through the local server; on any other host (the Vercel deployment) they
live in the browser's `localStorage` and never touch a server.

## The three outside services

- **Spotify** — the library. Read liked songs + top artists (to build the
  taste profile), save finds back (♥ → liked songs + a playlist), and
  remote-control playback ("full tracks" mode = crate acts as a remote for
  whatever device is playing). Auth is hand-rolled OAuth PKCE — no secret,
  a Client ID ships in the source on purpose.
- **Deezer** — the map. Unauthenticated, key-free API for search, related
  artists, albums, and 30-second previews. This graph is what gets walked.
  Both servers guard the proxy with the same path allowlist so it can't be
  used as an open relay, and both cache for a day.
- **Last.fm** — vestigial. The engine and local server still support
  track-level similarity if a key is hand-edited into the store, but the UI
  for it was removed and the Vercel deployment has no `/api/lastfm` at all.
  In practice the ⤵ tunnel always uses its artist-graph fallback.

## The dig (engine.js)

Every mode is the same skeleton with different filters:

1. **Seed** — what you typed, or artists weight-sampled from your profile
   (`count^0.7` + a boost for your top artists), narrowed to the active
   lane if one is selected.
2. **Walk** — resolve seeds on Deezer, pull related artists (hop 1), then
   *always* expand a second hop. Hop 2 is the point: hop 1 of any big
   artist is other big artists. The familiar↔far-out dial sets how many
   nodes get the second expansion.
3. **Filter** — by mode (*new*: artists you know fewer than 2 tracks by;
   *deep cuts*: artists you know ≥ 2 tracks by; *old gems*: year-capped),
   by the popular↔obscure dial (a log-curve fan-count ceiling, ~6.3M down
   to ~15k), and by learned dislike (2 bans of an artist quarters their
   weight, 4 removes them from the graph).
4. **Pick tracks** — *new* pulls mid-catalog (top-50 minus the top 2–10
   hits, deeper as the obscurity dial rises); *gems*/*deep* walk real
   albums for real years, and *deep* drops each album's most popular
   quarter.
5. **Finalize** — must have a preview; nothing already in the library
   (matched by normalized `artist::title` key *and* by ISRC); nothing
   seen in the last 14 days; then diversity caps — one track per artist,
   never two off the same album.

Every surviving track remembers its provenance (`via seed → branch`),
which becomes the tile tooltip and drives the ⤵ tunnel / drift chaining.

Two modes go beyond the skeleton: **bridge** runs a bidirectional beam
search (width 6, biased toward smaller artists) to find the stepping-stone
path between two artists you name, and **rabbit hole** walks strictly
downward in fan count until the graph runs out of smaller rooms.

## The profile (the only "database")

One JSON blob (`data/store.json` locally, `localStorage.crateStore`
deployed): Spotify tokens, settings, and the taste profile — per-artist
weights from your liked songs (feature credits count 0.4), your top
artists, genre **lanes** (Spotify genre strings regex-mapped into ten
buckets: rap, electronic, r&b/soul, indie/rock, jazz…), every library
track key + ISRC, release-year histogram — plus the memory: `seen`
(14-day no-repeat), `banned` (forever), `saved`, and the `finds` log
(capped at 400) that powers the profile panel and "bottle into a
playlist". Library scans are incremental: the scan stops at the newest
track it has already seen. Delete the store and crate forgets everything.

## Boot behavior worth knowing

- No Spotify connected → it digs anyway, seeded from a hardcoded list of
  15 starter artists ("open into music, not a form").
- `?preview=1` → dig without persisting anything (screenshots, tests).
  `?demo=Madlib&autodig=1` → seeded auto-dig. `?panel=profile` → open on
  the profile.
- `npm run check` (`check.mjs`) boots a throwaway server on 8824 and runs
  all five modes against live Deezer — the engine's end-to-end test, no
  Spotify needed.

## Honest edges (as of this writing)

- README documents three modes; the app ships five (bridge and rabbit
  hole are undocumented) and the screenshot predates the lane bar.
- The 14-day "seen" guarantee is enforced by an IntersectionObserver in
  grid mode, but bridge/rabbit-hole/dive results are marked seen on
  render, watched or not.
- The first library scan has no cancel button (`scanAbort` exists but
  nothing sets it).
- On the deployed version a very large library (~20k+ songs) would start
  pressing on the ~5MB localStorage ceiling, since every track key and
  ISRC is stored.
