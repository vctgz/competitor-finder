"""Core competitor-finding logic (no web layer).

For each "store, address" line we run two DataForSEO Google Maps live calls:

  1. LOCATE  — keyword = the raw line, country-scoped. The top maps result is the
               store; we keep its category, coordinates and place_id.
  2. NEARBY  — keyword = the store's category, centered on the store's coordinates.
               Google returns same-category businesses ranked by local proximity +
               prominence. We drop the store itself and keep the top few.

DataForSEO live tasks are billed on execution, so each call is fired exactly once
(no retries) — a retry on a timeout could double-bill a task that already ran.
Roughly $0.004 per location at current Maps SERP pricing.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field

import requests

_BASE = "https://api.dataforseo.com/v3"
_MAPS = "/serp/google/maps/live/advanced"
_TIMEOUT = 45
_HEADERS = {"User-Agent": "competitor-finder/1.0"}

# Country to scope the initial store lookup to (the nearby search is coordinate-based
# so it is locale-agnostic). Override with COMPFINDER_LOCATION, e.g. "United Kingdom".
LOCATION_NAME = os.getenv("COMPFINDER_LOCATION", "United States")
LANGUAGE_CODE = os.getenv("COMPFINDER_LANGUAGE", "en")
# Zoom for the nearby search: ~15 ≈ a few blocks, lower = wider net. 13–15 is sane.
NEARBY_ZOOM = os.getenv("COMPFINDER_ZOOM", "15")
NEARBY_DEPTH = int(os.getenv("COMPFINDER_DEPTH", "20"))


class ConfigError(RuntimeError):
    """Credentials are missing."""


def enabled() -> bool:
    return bool(os.getenv("DATAFORSEO_LOGIN") and os.getenv("DATAFORSEO_PASSWORD"))


@dataclass
class Place:
    title: str
    category: str
    address: str
    rating: float | None
    votes: int | None
    place_id: str
    latitude: float | None
    longitude: float | None
    distance_mi: float | None = None

    def as_dict(self) -> dict:
        return {
            "title": self.title,
            "category": self.category,
            "address": self.address,
            "rating": self.rating,
            "votes": self.votes,
            "place_id": self.place_id,
            "distance_mi": self.distance_mi,
        }


@dataclass
class Result:
    query: str
    found: bool = False
    store: Place | None = None
    competitors: list[Place] = field(default_factory=list)
    cost: float = 0.0
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "query": self.query,
            "found": self.found,
            "store": self.store.as_dict() if self.store else None,
            "competitors": [c.as_dict() for c in self.competitors],
            "cost": round(self.cost, 5),
            "error": self.error,
        }


def _post(payload: list[dict]) -> dict:
    """One-shot POST to the Maps live endpoint. No retry: billed on execution."""
    login = os.environ.get("DATAFORSEO_LOGIN")
    password = os.environ.get("DATAFORSEO_PASSWORD")
    if not (login and password):
        raise ConfigError("DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set")
    r = requests.post(
        f"{_BASE}{_MAPS}",
        auth=(login, password),
        json=payload,
        headers=_HEADERS,
        timeout=_TIMEOUT,
    )
    r.raise_for_status()
    return r.json()


def _first_task(data: dict) -> tuple[list[dict], float]:
    """Pull (items, cost) out of a DataForSEO maps response, tolerant of empties."""
    cost = float(data.get("cost") or 0.0)
    tasks = data.get("tasks") or []
    if not tasks:
        return [], cost
    task = tasks[0]
    if task.get("status_code") != 20000:
        raise RuntimeError(task.get("status_message") or "DataForSEO task error")
    result = task.get("result") or []
    items = (result[0].get("items") if result else None) or []
    return [it for it in items if isinstance(it, dict) and it.get("type") == "maps_search"], cost


def _to_place(it: dict) -> Place:
    rating = it.get("rating") or {}
    return Place(
        title=it.get("title") or "",
        category=it.get("category") or "",
        address=it.get("address") or "",
        rating=rating.get("value"),
        votes=rating.get("votes_count"),
        place_id=it.get("place_id") or "",
        latitude=it.get("latitude"),
        longitude=it.get("longitude"),
    )


def _haversine_mi(lat1, lon1, lat2, lon2) -> float | None:
    if None in (lat1, lon1, lat2, lon2):
        return None
    r = 3958.7613  # earth radius, miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)), 2)


def _norm(s: str) -> str:
    return "".join(c for c in (s or "").lower() if c.isalnum())


def _zoom_for_radius(r: float) -> int:
    """DataForSEO searches by Google Maps zoom level, not radius — pick a zoom wide
    enough to surface businesses out to `r` miles; the exact haversine distance then
    does the cutoff."""
    if r <= 1:
        return 15
    if r <= 2:
        return 14
    if r <= 4:
        return 13
    if r <= 8:
        return 12
    if r <= 16:
        return 11
    return 10  # ~32 mi viewport — covers the 30 mi max


# ---- Client market analysis (Claude) -------------------------------------------------
# Reads the client's homepage and asks Claude what they sell, their market, the best
# Google Maps search term for their LOCAL competitors, and a few named competitor brands.
# Mirrors the Cloudflare Worker; uses the official `anthropic` SDK here.

_CLIENT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "business": {"type": "string", "description": "One sentence: what this business sells / does."},
        "market": {"type": "string", "description": "Their market or industry category, a few words."},
        "search_keyword": {
            "type": "string",
            "description": "The single best Google Maps search term to find their direct LOCAL "
            "competitors (e.g. 'coffee shop', 'med spa', 'orthodontist'). Keep it generic and short.",
        },
        "competitors": {
            "type": "array",
            "items": {"type": "string"},
            "description": "A few well-known competitor brands in this market (named companies).",
        },
    },
    "required": ["business", "market", "search_keyword", "competitors"],
}

_CLIENT_SYS = (
    "You are a market analyst at a local-marketing agency. Given a client business (name + "
    "homepage text), identify what they sell, their market category, the single best Google "
    "Maps search term to find their direct LOCAL competitors (nearby businesses competing for "
    "the same walk-in customers), and a few well-known competitor brands. Ground the business "
    "and market in the website text; use general knowledge for named competitors."
)


@dataclass
class ClientBrief:
    name: str = ""
    website: str = ""
    business: str | None = None
    market: str | None = None
    keyword: str | None = None
    competitors: list[str] = field(default_factory=list)
    error: str | None = None

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "website": self.website,
            "business": self.business,
            "market": self.market,
            "keyword": self.keyword,
            "competitors": self.competitors,
            "error": self.error,
        }


def client_enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def _norm_url(u: str) -> str:
    u = (u or "").strip()
    if not u:
        return ""
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def _strip_html(html: str) -> str:
    html = re.sub(r"<script[\s\S]*?</script>", " ", html or "", flags=re.I)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.I)
    html = re.sub(r"<[^>]+>", " ", html)
    html = re.sub(r"&[a-z]+;", " ", html, flags=re.I)
    return re.sub(r"\s+", " ", html).strip()[:6000]


def _fetch_site_text(url: str) -> str:
    try:
        r = requests.get(url, headers=_HEADERS, timeout=20, allow_redirects=True)
        if not r.ok:
            return ""
        return _strip_html(r.text)
    except requests.RequestException:
        return ""


def analyze_client(name: str, website: str) -> ClientBrief:
    """One Claude call: read the client's homepage, return a market brief whose
    search keyword can drive every location's nearby search."""
    brief = ClientBrief(name=name or "", website=website or "")
    if not client_enabled():
        brief.error = "ANTHROPIC_API_KEY not set"
        return brief
    try:
        import json as _json

        import anthropic

        url = _norm_url(website)
        site_text = _fetch_site_text(url) if url else ""
        user_text = (
            f"Client name: {name or '(not given)'}\n"
            f"Website: {url or '(not given)'}\n\n"
            f"Homepage text:\n{site_text or '(could not fetch the site — infer from the name)'}"
        )
        resp = anthropic.Anthropic().messages.create(
            model=os.getenv("COMPFINDER_CLIENT_MODEL", "claude-opus-4-8"),
            max_tokens=1024,
            system=_CLIENT_SYS,
            messages=[{"role": "user", "content": user_text}],
            output_config={"format": {"type": "json_schema", "schema": _CLIENT_SCHEMA}},
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            brief.error = "analysis declined"
            return brief
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), None)
        if not text:
            brief.error = "no analysis returned"
            return brief
        parsed = _json.loads(text)
        brief.business = parsed.get("business")
        brief.market = parsed.get("market")
        brief.keyword = parsed.get("search_keyword")
        comps = parsed.get("competitors")
        brief.competitors = comps[:8] if isinstance(comps, list) else []
    except Exception as e:  # SDK/network/parse — degrade to per-location finding
        brief.error = f"{type(e).__name__}: {e}"
    return brief


_RELEVANCE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"keep": {"type": "array", "items": {"type": "integer"}}},
    "required": ["keep"],
}

_RELEVANCE_SYS = (
    "You filter a list of nearby businesses down to the GENUINE competitors of a client. "
    "A genuine competitor is a business a customer would realistically choose INSTEAD of the "
    "client for the same product or service. Exclude unrelated businesses — grocery stores, "
    "supermarkets, convenience stores, gas stations, pharmacies, etc. — UNLESS that category "
    "is itself the client's market. Judge each business by what it ACTUALLY is, using your "
    "knowledge of well-known brands: the Google category label is sometimes wrong (e.g. an "
    "apparel or lifestyle retailer mislabeled as a 'Beauty supply store'), so trust the real "
    "business over a mislabeled category. Return only the indices to keep."
)


def relevance_keep(brief: "ClientBrief", results: "list[Result]") -> "set[str] | None":
    """One fast Claude call: given the client's market and the unique candidate businesses
    across all locations, return the set of normalized titles that are genuine competitors.
    Returns None (no filtering) if disabled or anything fails."""
    if not client_enabled():
        return None
    by_key: dict[str, tuple[str, str]] = {}
    for r in results:
        if not r.found:
            continue
        for p in r.competitors:
            k = _norm(p.title)
            if k and k not in by_key:
                by_key[k] = (p.title, p.category)
    uniq = list(by_key.items())  # [(key, (title, category)), ...]
    if not uniq:
        return None
    try:
        import json as _json

        import anthropic

        listing = "\n".join(
            f"[{i}] {t} — {cat or '?'}" for i, (_k, (t, cat)) in enumerate(uniq)
        )
        resp = anthropic.Anthropic().messages.create(
            model=os.getenv("COMPFINDER_FILTER_MODEL", "claude-haiku-4-5"),
            max_tokens=1024,
            system=_RELEVANCE_SYS,
            messages=[{
                "role": "user",
                "content": f"Client: {brief.business} (market: {brief.market or '?'}).\n\n"
                f"Nearby businesses:\n{listing}\n\nReturn the indices of genuine competitors to keep.",
            }],
            output_config={"format": {"type": "json_schema", "schema": _RELEVANCE_SCHEMA}},
        )
        if getattr(resp, "stop_reason", None) == "refusal":
            return None
        text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), None)
        if not text:
            return None
        idx = _json.loads(text).get("keep")
        if not isinstance(idx, list):
            return None
        return {uniq[i][0] for i in idx if isinstance(i, int) and 0 <= i < len(uniq)}
    except Exception:
        return None


def find_competitors(
    query: str, *, count: int = 6, keyword: str | None = None,
    radius: float | None = None, pool: int | None = None,
) -> Result:
    """Locate the store described by `query`, then return up to `count` nearby
    competitors. If `keyword` is given (the client-market term from analyze_client)
    it drives the nearby search; otherwise the located store's own category is used.
    If `radius` (miles) is given, only competitors within that distance are kept.
    Never raises for a single bad row — captures the error on the Result so a batch
    can keep going."""
    query = (query or "").strip()
    res = Result(query=query)
    if not query:
        res.error = "empty line"
        return res
    try:
        located, cost = _first_task(
            _post([{
                "keyword": query,
                "location_name": LOCATION_NAME,
                "language_code": LANGUAGE_CODE,
                "depth": 1,
            }])
        )
        res.cost += cost
        if not located:
            res.error = "store not found on Google Maps"
            return res
        store = _to_place(located[0])
        res.store = store
        res.found = True

        search_kw = keyword or store.category or store.title
        # With a radius set, widen the search area and pull more candidates so the
        # distance filter has enough to work with; otherwise use the configured defaults.
        zoom = _zoom_for_radius(radius) if radius else NEARBY_ZOOM
        depth = max(NEARBY_DEPTH, 40) if radius else NEARBY_DEPTH
        nearby, cost2 = _first_task(
            _post([{
                "keyword": search_kw,
                "location_coordinate": f"{store.latitude},{store.longitude},{zoom}z",
                "language_code": LANGUAGE_CODE,
                "depth": depth,
            }])
        )
        res.cost += cost2

        store_key = store.place_id or _norm(store.title) + _norm(store.address)
        seen: set[str] = {store_key}
        comps: list[Place] = []
        for it in nearby:
            p = _to_place(it)
            key = p.place_id or _norm(p.title) + _norm(p.address)
            if key in seen:
                continue
            seen.add(key)
            p.distance_mi = _haversine_mi(
                store.latitude, store.longitude, p.latitude, p.longitude
            )
            if radius and (p.distance_mi is None or p.distance_mi > radius):
                continue
            comps.append(p)
            if len(comps) >= (pool or count):
                break
        res.competitors = comps
        if not comps:
            res.error = f"no competitors within {radius} mi" if radius else "no nearby competitors found"
    except ConfigError:
        raise
    except (requests.RequestException, RuntimeError, ValueError, KeyError, TypeError) as e:
        res.error = f"{type(e).__name__}: {e}"
    return res


if __name__ == "__main__":
    import sys
    import json as _json

    from dotenv import load_dotenv

    load_dotenv()
    q = " ".join(sys.argv[1:]) or "Blue Bottle Coffee, San Francisco"
    print(_json.dumps(find_competitors(q).as_dict(), indent=2))
