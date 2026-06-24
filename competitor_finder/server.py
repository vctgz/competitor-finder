"""Tiny stdlib web UI for Competitor Finder.

    python compfinder.py            # then open http://127.0.0.1:8001

Paste one "store, address" per line, hit Find. The server fans the rows out across
a small thread pool (two DataForSEO Maps calls each) and returns competitors as JSON,
which the page renders. Localhost-only, no framework — just http.server + requests.
"""

from __future__ import annotations

import json
import os
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

from . import finder

HOST = os.getenv("COMPFINDER_HOST", "127.0.0.1")
PORT = int(os.getenv("COMPFINDER_PORT", "8001"))
WORKERS = int(os.getenv("COMPFINDER_WORKERS", "5"))
MAX_ROWS = int(os.getenv("COMPFINDER_MAX_ROWS", "250"))
DEFAULT_COUNT = int(os.getenv("COMPFINDER_COUNT", "10"))

# Frontend lives in ui.html — the SAME file the Cloudflare Worker serves, so the
# local and deployed UIs can never drift. Read once at import.
PAGE = (Path(__file__).parent / "ui.html").read_text(encoding="utf-8")



def _process(text: str, count: int, client: str = "", website: str = "", radius=None) -> dict:
    if not finder.enabled():
        return {"error": "DataForSEO credentials missing — set DATAFORSEO_LOGIN and "
                         "DATAFORSEO_PASSWORD in .env"}
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    lines = lines[:MAX_ROWS]
    if not lines:
        return {"error": "no rows pasted"}
    count = max(3, min(20, count))

    # If a client name or website was given, analyze the market once up front; its
    # keyword drives every location's nearby search.
    client_name = client.strip()
    brief = finder.analyze_client(client, website) if (client_name or website.strip()) else None
    keyword = brief.keyword if brief else None

    # With a known market, fetch a deeper candidate pool so the relevance filter can drop
    # non-competitors (grocery/supermarket/etc.) and still leave `count` real ones.
    filter_on = bool(brief and brief.business and finder.client_enabled())
    pool = min(24, max(count * 3, 12)) if filter_on else count

    # Each line is an address; prepend the client name so Google Maps resolves it to the
    # client's own store at that address (no need to type the store name on every row).
    def _one(ln: str):
        q = f"{client_name}, {ln}" if client_name else ln
        return finder.find_competitors(q, count=count, keyword=keyword, radius=radius, pool=pool)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(_one, lines))

    keep = finder.relevance_keep(brief, results) if filter_on else None
    for r in results:
        if not r.found:
            continue
        r.competitors = [
            c for c in r.competitors if keep is None or finder._norm(c.title) in keep
        ][:count]
        if not r.competitors and not r.error:
            r.error = "no relevant competitors nearby"

    return {
        "results": [r.as_dict() for r in results],
        "brief": brief.as_dict() if brief else None,
        "cost": round(sum(r.cost for r in results), 5),
    }


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/index.html"):
            self.send_error(404)
            return
        html = PAGE.replace("__COUNT__", str(DEFAULT_COUNT)).encode("utf-8")
        self._send(200, html, "text/html; charset=utf-8")

    def do_POST(self):
        if self.path != "/api/find":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
            out = _process(
                payload.get("input", ""),
                int(payload.get("count", DEFAULT_COUNT)),
                payload.get("client", ""),
                payload.get("website", ""),
                payload.get("radius"),
            )
        except Exception as e:  # never 500 — surface it in the UI
            out = {"error": f"{type(e).__name__}: {e}"}
        self._send(200, json.dumps(out).encode("utf-8"), "application/json")

    def log_message(self, *args):
        pass


def main() -> None:
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    creds = "ready" if finder.enabled() else "⚠ DataForSEO creds NOT set"
    print(f"Competitor Finder → http://{HOST}:{PORT}   ({creds}, Ctrl-C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
