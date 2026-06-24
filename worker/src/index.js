// Competitor Finder — Cloudflare Worker.
//
// Same behaviour as the local Python server (competitor_finder/), ported to the
// Workers runtime: GET / serves the shared UI, POST /api/find runs two DataForSEO
// Google Maps calls per pasted row (locate the store, then find same-category
// businesses nearby) and returns JSON the page renders.
//
// The UI is imported from the SAME ui.html the Python server reads, so the local
// and deployed front-ends can't drift. Credentials come from Worker secrets
// (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD), never the repo.

import HTML from "../../competitor_finder/ui.html";
import ADVANCED from "../../competitor_finder/ui_advanced.html";
import CATEGORIES from "../../competitor_finder/categories.json";

const MAPS = "https://api.dataforseo.com/v3/serp/google/maps/live/advanced";

function cfg(env) {
  return {
    location: env.COMPFINDER_LOCATION || "United States",
    language: env.COMPFINDER_LANGUAGE || "en",
    zoom: env.COMPFINDER_ZOOM || "15",
    depth: Number(env.COMPFINDER_DEPTH || "20"),
    count: Number(env.COMPFINDER_COUNT || "10"),
    // Free Workers plan allows 50 subrequests/request; each row costs 2. 20 rows
    // (40) leaves headroom. Paid plan (1000) lets you raise COMPFINDER_MAX_ROWS.
    maxRows: Number(env.COMPFINDER_MAX_ROWS || "20"),
  };
}

async function dfsPost(env, payload) {
  // One-shot, no retry: DataForSEO live tasks are billed on execution, so re-firing
  // a timed-out task could double-bill one that already ran.
  const auth = "Basic " + btoa(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`);
  const r = await fetch(MAPS, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`DataForSEO HTTP ${r.status}`);
  return r.json();
}

function firstTask(data) {
  const cost = Number(data.cost || 0);
  const tasks = data.tasks || [];
  if (!tasks.length) return { items: [], cost };
  const task = tasks[0];
  if (task.status_code !== 20000) {
    throw new Error(task.status_message || "DataForSEO task error");
  }
  const result = task.result || [];
  const items = ((result[0] && result[0].items) || []).filter(
    (it) => it && typeof it === "object" && it.type === "maps_search"
  );
  return { items, cost };
}

function toPlace(it) {
  const rating = it.rating || {};
  return {
    title: it.title || "",
    category: it.category || "",
    category_ids: Array.isArray(it.category_ids) ? it.category_ids : [],
    address: it.address || "",
    rating: rating.value != null ? rating.value : null,
    votes: rating.votes_count != null ? rating.votes_count : null,
    place_id: it.place_id || "",
    latitude: it.latitude != null ? it.latitude : null,
    longitude: it.longitude != null ? it.longitude : null,
    distance_mi: null,
  };
}

function haversineMi(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null)) return null;
  const R = 3958.7613; // earth radius, miles
  const rad = (d) => (d * Math.PI) / 180;
  const p1 = rad(lat1), p2 = rad(lat2), dphi = rad(lat2 - lat1), dl = rad(lon2 - lon1);
  const a = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)) * 100) / 100;
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Loose category matching: reduce a category id / label to its meaningful word stems
// (first 5 chars), dropping generic retail words. Lets sibling categories match —
// e.g. selected "sporting_goods_store" matches a candidate "outdoor_sports_store" via
// the shared "sport" stem — so the keep test is broader than exact-id equality.
const GENERIC_CAT_WORDS = new Set([
  "store", "shop", "supplier", "dealer", "center", "centre", "market", "outlet",
  "retailer", "goods", "services", "service", "club", "company", "and", "of", "the",
]);
function catTokens(ids) {
  const out = new Set();
  for (const id of ids) {
    for (const t of String(id || "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 3 && !GENERIC_CAT_WORDS.has(t)) out.add(t.slice(0, 5));
    }
  }
  return out;
}

// Collapse same-store listings Google returns as separate results — e.g. "Kohl's" +
// "Kohl's Women's Clothing", "Meijer" + "Meijer Truck Unloading Entrance", or "Walmart
// Supercenter" + "Walmart Garden Center". Two entries are the same store when they sit at
// the same coordinates (~0.07 mi) AND one's normalized name is a prefix of the other's OR
// they share a first word. Keeps the main listing (no sub-department qualifier), else the
// shorter name.
const SUBLISTING = /(garden center|pharmacy|vision|optical|auto( center)?|tire|fuel|gas|deli|bakery|truck|liquor|pickup|customer service|money center)/i;
const firstWord = (s) => (s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
function dedupeStores(places) {
  const out = [];
  for (const p of places) {
    const np = norm(p.title), pfw = firstWord(p.title);
    const lat = p.latitude != null ? Math.round(p.latitude * 1000) : null;
    const lng = p.longitude != null ? Math.round(p.longitude * 1000) : null;
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      const q = out[i];
      const sameLoc =
        lat != null &&
        lat === (q.latitude != null ? Math.round(q.latitude * 1000) : null) &&
        lng === (q.longitude != null ? Math.round(q.longitude * 1000) : null);
      if (!sameLoc) continue;
      const nq = norm(q.title);
      if (np.startsWith(nq) || nq.startsWith(np) || (pfw && pfw === firstWord(q.title))) {
        // same store: prefer the main listing (no sub-department qualifier), then shorter.
        const pSub = SUBLISTING.test(p.title), qSub = SUBLISTING.test(q.title);
        if ((qSub && !pSub) || (qSub === pSub && (p.title || "").length < (q.title || "").length)) {
          out[i] = p;
        }
        merged = true;
        break;
      }
    }
    if (!merged) out.push(p);
  }
  return out;
}

// DataForSEO searches by Google Maps zoom level, not radius — pick a zoom wide enough to
// surface businesses out to `r` miles, then the exact haversine distance does the cutoff.
function zoomForRadius(r) {
  if (r <= 1) return 15;
  if (r <= 2) return 14;
  if (r <= 4) return 13;
  if (r <= 8) return 12;
  if (r <= 16) return 11;
  return 10; // ~32 mi viewport — covers the 30 mi max
}

// ---- Client market analysis (Claude) -------------------------------------------------
// Reads the client's homepage and asks Claude what they sell, their market, the best
// Google Maps search term for their LOCAL competitors, and a few named competitor brands.
// The search term then drives every location's nearby search so results are tuned to the
// client's actual market rather than each store's raw Google category.

const CLIENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    business: { type: "string", description: "One sentence: what this business sells / does." },
    market: { type: "string", description: "Their market or industry category, a few words." },
    search_keyword: {
      type: "string",
      description:
        "The single best Google Maps search term to find their direct LOCAL competitors " +
        "— the kind of nearby business competing for the same customers (e.g. 'coffee shop', " +
        "'med spa', 'orthodontist', 'boutique fitness studio'). Keep it generic and short.",
    },
    competitors: {
      type: "array",
      items: { type: "string" },
      description: "A few well-known competitor brands in this market (named companies).",
    },
    competitor_categories: {
      type: "array",
      items: { type: "string" },
      description:
        "10-15 Google Business category names (singular, lowercase, e.g. 'sporting goods store', " +
        "'gun shop', 'farm equipment supplier', 'garden center', 'auto parts store') covering the " +
        "client's own category PLUS adjacent categories where they compete for the same customers. " +
        "For a broad/general/big-box retailer, span all their departments AND include the large " +
        "general-merchandise stores that compete across many departments — 'department store', " +
        "'discount store', 'warehouse club', 'home improvement store' (these are how big-box chains " +
        "like Walmart, Target, Costco, Home Depot and Lowe's appear). Use real Google Maps category names.",
    },
    broad_retailer: {
      type: "boolean",
      description:
        "true ONLY for a genuine general-merchandise / multi-department / big-box retailer — a " +
        "farm & ranch store, general store, department store, home center, or hardware superstore " +
        "selling across many unrelated departments, so big-box chains (Walmart, Target, Home " +
        "Depot, Lowe's) are real cross-department competitors. false for any focused or single-" +
        "category business — a pharmacy, drugstore, grocery, supermarket, convenience store, " +
        "restaurant, gym, or specialty shop — EVEN IF it stocks some incidental general merchandise.",
    },
  },
  required: ["business", "market", "search_keyword", "competitors", "competitor_categories", "broad_retailer"],
};

// Contextual /api/find doesn't need the category list (that's only for the /advanced chips),
// so it uses a slim schema — less to generate = a faster brief. Reuses the property defs.
const CLIENT_SCHEMA_SLIM = {
  type: "object",
  additionalProperties: false,
  properties: {
    business: CLIENT_SCHEMA.properties.business,
    market: CLIENT_SCHEMA.properties.market,
    search_keyword: CLIENT_SCHEMA.properties.search_keyword,
    competitors: CLIENT_SCHEMA.properties.competitors,
    broad_retailer: CLIENT_SCHEMA.properties.broad_retailer,
  },
  required: ["business", "market", "search_keyword", "competitors", "broad_retailer"],
};

const CLIENT_SYS =
  "You are a market analyst at a local-marketing agency. Given a client business (name + " +
  "homepage text), identify what they sell, their market category, the single best Google " +
  "Maps search term to find their direct LOCAL competitors (nearby businesses competing for " +
  "the same walk-in customers), a few well-known competitor brands, and the Google Business " +
  "categories a customer might shop instead (covering every department of a broad retailer). " +
  "When the client is a broad, general-merchandise, or big-box retailer, the category list MUST " +
  "also include the large multi-department stores that compete across their departments — " +
  "'department store', 'discount store', 'warehouse club', 'home improvement store' (this is how " +
  "Walmart, Target, Costco, Home Depot and Lowe's surface). " +
  "Ground the business and market in the website text; use general knowledge for the rest.";

// Snap an AI-produced category label to a real Google taxonomy id, so suggested chips
// are always valid for searching + exact filtering.
const CAT_SET = new Set(CATEGORIES);
function matchCategory(label) {
  let n = (label || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!n) return null;
  if (CAT_SET.has(n)) return n;
  if (CAT_SET.has(n + "_store")) return n + "_store";
  if (n.endsWith("_store") && CAT_SET.has(n.slice(0, -6))) return n.slice(0, -6);
  let best = null;
  for (const id of CATEGORIES) {
    if (id === n) return id;
    if (id.includes(n) || n.includes(id)) {
      if (!best || Math.abs(id.length - n.length) < Math.abs(best.length - n.length)) best = id;
    }
  }
  return best;
}
function matchCategories(labels) {
  const out = [];
  const seen = new Set();
  for (const l of labels || []) {
    const id = matchCategory(l);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out.slice(0, 15);
}

function normUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

async function fetchSiteText(url) {
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "competitor-finder/1.0" },
      redirect: "follow",
    });
    if (!r.ok) return "";
    return stripHtml(await r.text());
  } catch {
    return "";
  }
}

async function analyzeClient(env, name, website, slim = false) {
  const brief = {
    name: name || "",
    website: website || "",
    business: null,
    market: null,
    keyword: null,
    competitors: [],
    categories: [],
    broad: false,
    error: null,
  };
  if (!env.ANTHROPIC_API_KEY) {
    brief.error = "ANTHROPIC_API_KEY not set";
    return brief;
  }
  try {
    const url = normUrl(website);
    const siteText = url ? await fetchSiteText(url) : "";
    const userText =
      `Client name: ${name || "(not given)"}\n` +
      `Website: ${url || "(not given)"}\n\n` +
      `Homepage text:\n${siteText || "(could not fetch the site — infer from the name)"}`;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.COMPFINDER_BRIEF_MODEL || "claude-sonnet-4-6",
        max_tokens: 1024,
        system: CLIENT_SYS,
        messages: [{ role: "user", content: userText }],
        output_config: {
          format: { type: "json_schema", schema: slim ? CLIENT_SCHEMA_SLIM : CLIENT_SCHEMA },
          effort: "low",
        },
      }),
    });
    if (!r.ok) {
      brief.error = `Claude HTTP ${r.status}`;
      return brief;
    }
    const data = await r.json();
    if (data.stop_reason === "refusal") {
      brief.error = "analysis declined";
      return brief;
    }
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) {
      brief.error = "no analysis returned";
      return brief;
    }
    const parsed = JSON.parse(block.text);
    brief.business = parsed.business || null;
    brief.market = parsed.market || null;
    brief.keyword = parsed.search_keyword || null;
    brief.competitors = Array.isArray(parsed.competitors) ? parsed.competitors.slice(0, 8) : [];
    brief.broad = !!parsed.broad_retailer;
    if (!slim) {
      brief.categories = matchCategories(parsed.competitor_categories); // AI labels -> taxonomy ids
      if (parsed.broad_retailer) {
        // Broad/big-box retailer: ensure the large general-merchandise chains (Walmart,
        // Target, Costco, Home Depot, Lowe's) are always in the /advanced chip set.
        const BIG_BOX = ["department_store", "discount_store", "warehouse_club", "home_improvement_store"];
        brief.categories = [...new Set([...brief.categories, ...BIG_BOX])].slice(0, 16);
      }
    }
  } catch (e) {
    brief.error = `${e.name}: ${e.message}`;
  }
  return brief;
}

// ---- Relevance filter (Claude Haiku) -------------------------------------------------
// Google Maps pads thin local results with the nearest big-box stores (grocery,
// supermarket, convenience…). This drops candidates that aren't genuine competitors of
// the client's market. One fast call per run, deduped to unique businesses across all
// locations (relevance is per business-type, not per-location).

const RELEVANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { keep: { type: "array", items: { type: "integer" } } },
  required: ["keep"],
};

const RELEVANCE_SYS =
  "You filter a list of nearby businesses down to the GENUINE competitors of a client. " +
  "A genuine competitor is a business a customer would realistically choose INSTEAD of the " +
  "client for the same product or service. Exclude unrelated businesses — grocery stores, " +
  "supermarkets, convenience stores, gas stations, pharmacies, etc. — UNLESS that category " +
  "is itself the client's market. Judge each business by what it ACTUALLY is, using your " +
  "knowledge of well-known brands: the Google category label is sometimes wrong (e.g. an " +
  "apparel or lifestyle retailer mislabeled as a 'Beauty supply store'), so trust the real " +
  "business over a mislabeled category. Return only the indices to keep.";

async function relevanceKeep(env, brief, results, broad) {
  const byKey = new Map();
  for (const r of results) {
    if (!r.found) continue;
    for (const p of r.competitors) {
      const k = norm(p.title);
      if (k && !byKey.has(k)) byKey.set(k, { title: p.title, category: p.category });
    }
  }
  const uniq = [...byKey.entries()]; // [[key, {title, category}], ...]
  if (!uniq.length) return null;
  try {
    const list = uniq.map(([, v], i) => `[${i}] ${v.title} — ${v.category || "?"}`).join("\n");
    const broadHint = broad
      ? "This client is a broad / general-merchandise retailer, so large big-box and " +
        "general-merchandise chains (Walmart, Target, Costco, Home Depot, Lowe's, Meijer, " +
        "Kohl's, etc.) ARE genuine competitors — keep them.\n\n"
      : "";
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: env.COMPFINDER_FILTER_MODEL || "claude-haiku-4-5",
        max_tokens: 1024,
        system: RELEVANCE_SYS,
        messages: [{
          role: "user",
          content:
            `Client: ${brief.business} (market: ${brief.market || "?"}).\n\n` +
            broadHint +
            `Nearby businesses:\n${list}\n\nReturn the indices of genuine competitors to keep.`,
        }],
        output_config: { format: { type: "json_schema", schema: RELEVANCE_SCHEMA } },
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data.stop_reason === "refusal") return null;
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) return null;
    const idx = JSON.parse(block.text).keep;
    if (!Array.isArray(idx)) return null;
    const keep = new Set();
    for (const i of idx) if (uniq[i]) keep.add(uniq[i][0]);
    return keep;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------------------

async function findCompetitors(env, query, pool, c, keywords, radius, categoryIds, bigFrom, clientName) {
  query = (query || "").trim();
  const res = { query, found: false, store: null, competitors: [], cost: 0, error: null };
  if (!query) {
    res.error = "empty line";
    return res;
  }
  try {
    const loc = await dfsPost(env, [
      { keyword: query, location_name: c.location, language_code: c.language, depth: 1 },
    ]);
    const located = firstTask(loc);
    res.cost += located.cost;
    if (!located.items.length) {
      res.error = "store not found on Google Maps";
      return res;
    }
    const store = toPlace(located.items[0]);
    res.store = store;
    res.found = true;

    // One search per keyword. Default is a single keyword (AI market term, or the located
    // store's own category); user-specified competitor types give several. With a radius
    // set, widen the area + pull more candidates.
    const kws = keywords && keywords.length ? keywords : [store.category || store.title];
    const multi = kws.length > 1;
    const zoom = radius ? zoomForRadius(radius) : c.zoom;
    const depth = radius ? Math.max(c.depth, 40) : c.depth;
    const selTokens = categoryIds ? catTokens([...categoryIds]) : null;
    const seen = new Set([store.place_id || norm(store.title) + norm(store.address)]);

    const search = (kw) =>
      dfsPost(env, [{
        keyword: kw,
        location_coordinate: `${store.latitude},${store.longitude},${zoom}z`,
        language_code: c.language,
        depth,
      }]).then(firstTask);

    // Loose keep: exact category-id match OR a shared meaningful token (sibling categories).
    const matches = (p) => {
      if (!categoryIds) return true;
      const ids = p.category_ids || [];
      if (ids.some((id) => categoryIds.has(id))) return true;
      if (selTokens) for (const t of catTokens([...ids, p.category])) if (selTokens.has(t)) return true;
      return false;
    };

    const nc = clientName ? norm(clientName) : "";
    const sameBrand = (p) => {
      if (!nc || nc.length < 4) return false;
      const nt = norm(p.title); // skip OTHER locations of the client's own brand
      return nt.startsWith(nc) || (nc.startsWith(nt) && nt.length >= 4);
    };
    const consume = (nearby, fromBig) => {
      res.cost += nearby.cost;
      for (const it of nearby.items) {
        const p = toPlace(it);
        const key = p.place_id || norm(p.title) + norm(p.address);
        if (seen.has(key)) continue;
        seen.add(key);
        if (sameBrand(p)) continue;
        p.distance_mi = haversineMi(store.latitude, store.longitude, p.latitude, p.longitude);
        if (radius && (p.distance_mi == null || p.distance_mi > radius)) continue;
        if (!matches(p)) continue;
        // Bucket by SEARCH SOURCE: core = the primary on-market search (the client's direct
        // competitors), fromBig = a big-box search. This preserves the direct competitors
        // even when they're farther than nearby big-box listings.
        p.fromBig = !!fromBig;
        res.competitors.push(p);
        if (!multi && res.competitors.length >= pool) return; // single keyword: stop at pool
      }
    };

    if (multi) {
      // Fire every search concurrently, then merge — much faster than sequential.
      const tasks = await Promise.all(
        kws.map((kw, i) => search(kw).then((r) => ({ r, big: bigFrom != null && i >= bigFrom })))
      );
      for (const { r, big } of tasks) consume(r, big);
    } else {
      consume(await search(kws[0]), false);
    }
    res.competitors = dedupeStores(res.competitors);
    if (multi && bigFrom != null) {
      // Keep the nearest on-market (core) competitors AND the nearest big-box-search hits in
      // separate buckets, so the direct specialty competitors aren't crowded out of the pool
      // by closer big-box listings before the relevance filter + final mix run.
      const byD = (a, b) => (a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9);
      const core = res.competitors.filter((p) => !p.fromBig).sort(byD).slice(0, 30);
      const big = res.competitors.filter((p) => p.fromBig).sort(byD).slice(0, 20);
      res.competitors = [...core, ...big];
    } else if (multi) {
      res.competitors.sort((a, b) => (a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9));
      res.competitors = res.competitors.slice(0, pool);
    } else {
      res.competitors = res.competitors.slice(0, pool);
    }
    if (!res.competitors.length) {
      res.error = radius ? `no competitors within ${radius} mi` : "no nearby competitors found";
    }
  } catch (e) {
    res.error = `${e.name}: ${e.message}`;
  }
  return res;
}

// Big-box / general-merchandise categories + the search terms that surface them. Used to
// blend small local competitors with big-box chains for broad retailers.
const BIG_BOX_IDS = new Set([
  "department_store", "discount_store", "warehouse_club", "home_improvement_store",
  "supermarket", "hypermarket", "general_store", "variety_store",
]);
const BIG_BOX_TERMS = ["department store", "home improvement store"];
// A business is "big-box" by what it IS — its category or being a known general-merchandise
// chain — not by which search returned it. Keeps the mix buckets honest.
const isBigBoxCat = (p) => (p.category_ids || []).some((id) => BIG_BOX_IDS.has(id));
const BIG_BOX_BRANDS = [
  "walmart", "target", "costco", "homedepot", "lowes", "menards", "kohls", "meijer",
  "samsclub", "bjs", "macys", "jcpenney", "biglots", "kmart", "dollargeneral",
  "dollartree", "familydollar", "fredmeyer", "scheels", "fleetfarm",
];
const isBigBoxBrand = (title) => {
  const n = norm(title);
  return BIG_BOX_BRANDS.some((b) => n.includes(b));
};
const isBigBox = (p) => isBigBoxCat(p) || isBigBoxBrand(p.title);

// A nice mix: for a broad retailer, the on-market (core) competitors from the primary
// keyword get the majority of slots; the nearest big-box chains (from the big-box searches,
// tagged srcBig) are reserved to ~30%. This guarantees real specialty/local competitors
// show up alongside the big-box anchors instead of the list collapsing to all chains. If
// one bucket is short, backfill from the other. Focused clients: nearest N.
function pickMix(cands, n, broad) {
  const byDist = (a, b) => (a.distance_mi ?? 1e9) - (b.distance_mi ?? 1e9);
  if (!broad) return [...cands].sort(byDist).slice(0, n);
  const core = cands.filter((p) => !p.fromBig).sort(byDist);
  // big bucket: actual big-box giants first (so the reserved slots surface Walmart / Home
  // Depot / Target ahead of generic hardware), then by distance.
  const big = cands
    .filter((p) => p.fromBig)
    .sort((a, b) => (isBigBox(b) ? 1 : 0) - (isBigBox(a) ? 1 : 0) || byDist(a, b));
  const wantBig = Math.min(big.length, Math.max(2, Math.round(n * 0.3)));
  const chosenBig = big.slice(0, wantBig);
  const chosenCore = core.slice(0, n - chosenBig.length);
  let out = [...chosenCore, ...chosenBig];
  if (out.length < n) {
    // backfill from whatever remains (core ran short, or vice versa)
    const rest = [...core.slice(chosenCore.length), ...big.slice(chosenBig.length)].sort(byDist);
    out = out.concat(rest.slice(0, n - out.length));
  }
  return out.sort(byDist);
}

async function handleFind(request, env, c) {
  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    return {
      error:
        "DataForSEO credentials not configured — set the DATAFORSEO_LOGIN and " +
        "DATAFORSEO_PASSWORD Worker secrets (wrangler secret put ...).",
    };
  }
  const body = await request.json();
  let lines = (body.input || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { error: "no rows pasted" };
  const count = Math.max(3, Math.min(20, parseInt(body.count, 10) || c.count));
  const radius = body.radius ? Number(body.radius) : null;
  const clientName = (body.client || "").trim();

  // Optional competitor categories (exact Google category ids — AI-suggested chips and/or
  // typeahead). When set, each is searched and results are filtered to those exact
  // categories, replacing the AI keyword + relevance filter with explicit criteria.
  const cats = (Array.isArray(body.categories) ? body.categories : [])
    .filter((s) => typeof s === "string" && s.trim())
    .slice(0, 16);
  const catMode = cats.length > 0;

  // Contextual mode analyzes the market once for the brief + keyword. Category mode skips
  // it (the user already chose criteria via a prior /api/suggest call).
  let brief = null;
  if (!catMode && (clientName || (body.website || "").trim())) {
    brief = await analyzeClient(env, body.client, body.website, true); // slim = faster
  }

  // Build the per-row search keywords. Category mode: one per chip. Contextual mode: the
  // AI's primary keyword, plus a couple of big-box terms when the AI flags a TRUE broad
  // retailer, so the result blends small local competitors with big-box chains.
  const broad = !catMode && !!(brief && brief.broad);
  const overrideKeyword = brief && brief.keyword ? brief.keyword : null;
  const keywords = catMode
    ? cats.map((id) => id.replace(/_/g, " "))      // "sporting_goods_store" -> "sporting goods store"
    : overrideKeyword
    ? [overrideKeyword, ...(broad ? BIG_BOX_TERMS : [])]
    : [];
  // Index in `keywords` where the big-box searches begin — their hits are bucketed apart
  // from the primary on-market competitors for the final mix. null = no mix.
  const bigFrom = broad && keywords.length > 1 ? keywords.length - BIG_BOX_TERMS.length : null;

  // Each row costs (1 locate + N searches) subrequests — bound rows to the budget.
  const perRow = 1 + Math.max(1, keywords.length || 1);
  lines = lines.slice(0, Math.min(c.maxRows, Math.max(1, Math.floor(950 / perRow))));

  const categoryIds = catMode ? new Set(cats) : null;
  // The AI relevance filter applies in contextual mode (category mode is already explicit).
  const filterOn = !catMode && !!(brief && brief.business && env.ANTHROPIC_API_KEY);
  // Contextual mode pulls a deeper pool (deeper still for broad retailers) so big-box chains
  // a little farther out still reach the relevance filter and the final mix.
  const pool = catMode ? count : filterOn ? (broad ? 50 : 30) : count;

  // Each line is an address; prepend the client name so Google Maps resolves it to the
  // client's own store at that address (no need to type the store name on every row).
  const results = await Promise.all(
    lines.map((ln) =>
      findCompetitors(env, clientName ? `${clientName}, ${ln}` : ln, pool, c, keywords, radius, categoryIds, bigFrom, clientName)
    )
  );

  // Contextual: relevance-filter (keeps big-box for broad retailers), then a balanced mix.
  // Category: explicit criteria already applied — just keep the nearest `count`.
  const keep = filterOn ? await relevanceKeep(env, brief, results, broad) : null;
  for (const r of results) {
    if (!r.found) continue;
    const genuine = keep ? r.competitors.filter((p) => keep.has(norm(p.title))) : r.competitors;
    r.competitors = catMode ? genuine.slice(0, count) : pickMix(genuine, count, broad);
    if (!r.competitors.length && !r.error) {
      r.error = catMode ? "no matching competitors nearby" : "no relevant competitors nearby";
    }
  }

  return {
    results,
    brief,
    cost: Math.round(results.reduce((s, r) => s + r.cost, 0) * 1e5) / 1e5,
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const c = cfg(env);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(HTML.replace("__COUNT__", String(c.count)), {
        // no-store so a fresh deploy is served immediately (no stale edge/browser cache).
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "GET" && url.pathname === "/advanced") {
      // Retained category-chips version: manual competitor-type selection.
      return new Response(ADVANCED.replace("__COUNT__", String(c.count)), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (request.method === "GET" && url.pathname === "/api/categories") {
      // Static Google business-category taxonomy for the typeahead (machine-form ids).
      return new Response(JSON.stringify(CATEGORIES), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      });
    }
    if (request.method === "POST" && url.pathname === "/api/suggest") {
      try {
        const body = await request.json();
        if (!env.ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not set" });
        const brief = await analyzeClient(env, body.client, body.website);
        return json({ brief });
      } catch (e) {
        return json({ error: `${e.name}: ${e.message}` });
      }
    }
    if (request.method === "POST" && url.pathname === "/api/find") {
      try {
        return json(await handleFind(request, env, c));
      } catch (e) {
        // Never 500 — surface the error in the UI like the Python server does.
        return json({ error: `${e.name}: ${e.message}` });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
