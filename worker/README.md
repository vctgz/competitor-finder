# Competitor Finder — Cloudflare Worker

Serverless deployment of the tool. Same behaviour as the local Python server
([../competitor_finder/](../competitor_finder/)) — in fact it serves the **same**
[`ui.html`](../competitor_finder/ui.html), so the local and deployed UIs can't drift.
The backend logic is ported to JS in [`src/index.js`](src/index.js) and verified to
return identical results to the Python version against the live API.

## One-time deploy

From this `worker/` directory:

```bash
npm install                              # already done once; installs wrangler
npx wrangler login                       # opens your browser to authorize Cloudflare

# Secrets as encrypted values (NOT in any file). Paste each when prompted:
npx wrangler secret put DATAFORSEO_LOGIN
npx wrangler secret put DATAFORSEO_PASSWORD
npx wrangler secret put ANTHROPIC_API_KEY   # for the client market-brief feature

npx wrangler deploy
```

## Client market brief (optional, AI)

If a **Client name** and/or **Main website** are entered, the Worker fetches the
client's homepage and runs one `claude-opus-4-8` call (structured output) to produce a
market brief — what they sell, their market, a few named competitors, and the best
Google Maps search term for their local rivals. That keyword then drives every
location's nearby search, so results are tuned to the client's market instead of each
store's raw Google category. Needs the `ANTHROPIC_API_KEY` secret; without it, the tool
still works (per-location category search, no brief).

`deploy` prints your live URL: `https://compfinder.<your-subdomain>.workers.dev`.
That's it — it stays up with your Mac off.

## Updating it later

Edit the UI ([`../competitor_finder/ui.html`](../competitor_finder/ui.html)) or the
logic ([`src/index.js`](src/index.js)), then:

```bash
npx wrangler deploy
```

## Local testing (optional)

```bash
npx wrangler dev --port 8788      # http://127.0.0.1:8788
```

Reads creds from `worker/.dev.vars` (git-ignored; copied from the project `.env`).

## Notes

- **No login gate.** The URL is open; spend is bounded by your DataForSEO account
  cap. To add an email gate later with zero code changes, turn on **Cloudflare
  Access** (Zero Trust → Access → Applications → add this Worker's hostname, policy
  = allowed emails). Free for ≤ 50 users.
- **Row cap.** Free Workers plan allows 50 DataForSEO subrequests per request; each
  row uses 2, so `COMPFINDER_MAX_ROWS` defaults to 20. Raise it in
  [`wrangler.toml`](wrangler.toml) on a paid plan (1000 subrequests).
- **Tunables** (location, zoom, default count, max rows) live in
  [`wrangler.toml`](wrangler.toml) `[vars]` — edit and redeploy.
