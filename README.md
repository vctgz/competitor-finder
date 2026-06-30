# GeoGrep 📍

A little tool I made to find local competitors from a list of store addresses. Paste
addresses, it finds each store on Google Maps, looks around it, and gives you the nearest
competitors. There's an optional AI pass that cleans up the matches.

It runs on the [DataForSEO](https://dataforseo.com) API for the maps stuff, plus Claude
(optional) for the smart filtering.

## Run it yourself

You'll need a DataForSEO login + password (and an Anthropic API key if you want the AI bits).

**Local:**

```bash
pip install -r requirements.txt
cp .env.example .env      # drop your keys in here
python geogrep.py         # → http://localhost:8001
```

**Hosted (Cloudflare Worker):**

```bash
cd worker
npx wrangler deploy
wrangler secret put DATAFORSEO_LOGIN       # then DATAFORSEO_PASSWORD, ANTHROPIC_API_KEY
```

That's it. Two modes: `/` just works, `/advanced` lets you pick exact competitor types.
