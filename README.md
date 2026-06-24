# Competitor Finder

Internal tool. Paste a client's store addresses (one per line) and get the nearest
**competitors** for each location — a mix of direct/specialty rivals and, for broad
retailers, the big-box chains (Walmart, Home Depot, Target…).

Backed by **DataForSEO** (Google Maps) for store lookup + nearby search, and **Claude**
for the market read and relevance filter.

## Two ways to run

**Cloud (Cloudflare Worker) — the deployed product:**
```bash
cd worker
npx wrangler deploy
```
Lives at `https://compfinder.<subdomain>.workers.dev`. Secrets via `wrangler secret put
DATAFORSEO_LOGIN | DATAFORSEO_PASSWORD | ANTHROPIC_API_KEY`. See [worker/README.md](worker/README.md).

**Local (Python, zero deps beyond `requests`):**
```bash
pip install -r requirements.txt   # or use the bundled .venv
python compfinder.py              # → http://127.0.0.1:8001
```
Reads creds from `.env` (copy `.env.example`). See [competitor_finder/README.md](competitor_finder/README.md).

## How it works
1. **Locate** each pasted address as the client's store (Google Maps) → coordinates.
2. **Search** nearby for the client's market (AI-derived keyword), plus a couple of
   big-box terms when the client is a broad/general-merchandise retailer.
3. **Filter** the candidates with a relevance check, then return a balanced mix —
   direct competitors preserved even when farther, big-box giants in reserved slots.

## Layout
- `competitor_finder/` — local Python server (`server.py`), finder logic (`finder.py`),
  shared UI (`ui.html`, `ui_advanced.html`), Google category taxonomy (`categories.json`).
- `worker/` — the Cloudflare Worker (serves the same `ui.html`; `/advanced` = manual
  competitor-type chips).
- `compfinder.py` — local launcher.

## Modes
- **Simple** (`/`) — automatic: AI reads the client, finds competitors, balances the mix.
- **Advanced** (`/advanced`) — pick exact competitor types (Google categories) to search.
