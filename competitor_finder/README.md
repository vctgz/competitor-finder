# Competitor Finder

Internal tool. Paste your stores + addresses (one per line, straight from a sheet),
get the nearest **same-category competitors** for each location.

## Run

```bash
python compfinder.py          # → http://127.0.0.1:8001
```

Needs `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` in `.env` (already set here).
Uses only the stdlib + `requests` — no extra dependencies.

## How it works

Two DataForSEO Google Maps calls per row (~$0.004/location):

1. **Locate** — the pasted line is searched as-is; the top Maps result is the store
   (we keep its category, coordinates, place_id). The matched name + address is shown
   so you can confirm it found the right place.
2. **Nearby** — that category is searched centered on the store's coordinates. Google
   ranks results by local proximity + prominence; we drop the store itself and keep the
   top N (3–6, adjustable).

## Client market brief (optional, AI)

Enter a **Client name** and/or **Main website** above the paste box and the tool reads
the client's homepage and runs one `claude-opus-4-8` call to produce a market brief
(what they sell, their market, named competitors) plus the best Google Maps search term
for their local rivals. That keyword drives every location's nearby search, so results
are tuned to the client's market rather than each store's raw Google category. Needs
`ANTHROPIC_API_KEY` in `.env`; without it the tool still works (per-location category
search, no brief).

## Features

- Paste-friendly: one store per line, commas in addresses are fine.
- Up to 50 rows per run, fetched concurrently.
- Distance (mi), rating + review count, and a "view on Maps" link per competitor.
- **Export CSV** — one flat row per competitor, opens straight in Sheets/Excel.
- Running API spend shown after each run.

## Config (env, all optional)

| var | default | meaning |
|-----|---------|---------|
| `COMPFINDER_PORT` | `8001` | server port |
| `COMPFINDER_COUNT` | `6` | default competitors per location |
| `COMPFINDER_LOCATION` | `United States` | country to scope the store lookup |
| `COMPFINDER_ZOOM` | `15` | nearby radius (lower = wider) |
| `COMPFINDER_WORKERS` | `5` | concurrent rows |
| `COMPFINDER_MAX_ROWS` | `50` | safety cap per run |
