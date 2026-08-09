// Vercel serverless Deezer proxy — same whitelist as the local server.
// Edge-cached so repeat digs don't re-hit Deezer.
const DEEZER_OK = /^(search(\/artist|\/track|\/album)?|artist\/\d+(\/related|\/top|\/albums)?|album\/\d+(\/tracks)?|track\/(\d+|isrc:[A-Za-z0-9-]+))$/;

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const rest = req.url.replace(/^\/api\/deezer\//, "");
  const [p] = rest.split("?");
  if (!DEEZER_OK.test(decodeURIComponent(p))) return res.status(400).json({ error: "path not allowed" });
  try {
    const r = await fetch("https://api.deezer.com/" + rest);
    const text = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (r.status === 200) res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600");
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}
