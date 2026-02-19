// search.js — Local KB + Smart Google Places (Mechanic + Parts/Tools + PriceLevel) — PRO

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

/* =========================================================
   FETCH SAFE (Node 18+ or fallback)
========================================================= */
let _fetch = globalThis.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
  const mod = await import("node-fetch");
  _fetch = mod.default;
  return _fetch;
}

/* =========================================================
   LOAD LOCAL KB ONCE
========================================================= */
let KB = [];
let KB_LOADED = false;

function loadKBOnce() {
  if (KB_LOADED) return;
  KB_LOADED = true;

  try {
    if (!fs.existsSync(DATA_DIR)) return;

    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) KB.push(...parsed.map((x) => ({ ...x, __source: f })));
      else if (parsed?.items && Array.isArray(parsed.items)) KB.push(...parsed.items.map((x) => ({ ...x, __source: f })));
      else if (parsed && typeof parsed === "object") KB.push({ ...parsed, __source: f });
    }
  } catch (e) {
    console.error("KB load error:", e?.message || e);
    KB = [];
  }
}

/* =========================================================
   UTILITIES
========================================================= */
function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function safeStr(v) {
  try {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(safeStr).join(" ");
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  } catch (_) {
    return "";
  }
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function scoreMatch(query, recordText) {
  const q = normalizeText(query);
  const text = normalizeText(recordText);
  if (!q || !text) return 0;

  let score = 0;

  // phrase bonus
  if (q.length >= 10 && text.includes(q)) score += 10;

  // token scoring
  const tokens = q.split(" ").filter(Boolean).slice(0, 24);
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (text.includes(t)) score += 2;
    if (/^p0\d{3}$/i.test(t) && text.includes(t.toLowerCase())) score += 8;
  }

  return score;
}

function recordToText(r) {
  return normalizeText(
    [
      r.title,
      r.name,
      r.problem,
      r.symptom,
      r.symptoms,
      r.description,
      r.likely_causes,
      r.recommended_checks,
      r.steps,
      r.tags,
      r.category,
      r.system,
    ]
      .filter(Boolean)
      .map(safeStr)
      .join(" ")
  );
}

/* =========================================================
   PLACES INTENT + MODE (MECHANIC vs PARTS/TOOLS)
========================================================= */
function looksLikePlacesIntent(q = "") {
  const t = String(q || "").toLowerCase();

  // Strong signal: ZIP in query
  if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true;

  // Mechanic/shops
  const shopWords = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "near me",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "workshop",
    "ورشة",
    "ورش",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "وين اروح",
  ];

  // Parts & tools
  const partsWords = [
    "auto parts",
    "car parts",
    "parts store",
    "tool store",
    "tools store",
    "hardware store",
    "autozone",
    "o'reilly",
    "oreilly",
    "advance auto",
    "napa",
    "قطع غيار",
    "محل قطع",
    "محل قطع غيار",
    "محل ادوات",
    "محل أدوات",
    "أدوات",
    "ادوات",
  ];

  return shopWords.some((w) => t.includes(w)) || partsWords.some((w) => t.includes(w));
}

function detectModeFromText(q = "") {
  const t = String(q || "").toLowerCase();

  // parts/tools intent
  const partsSignals = [
    "auto parts",
    "car parts",
    "parts store",
    "hardware store",
    "tool store",
    "tools store",
    "autozone",
    "o'reilly",
    "oreilly",
    "advance auto",
    "napa",
    "قطع غيار",
    "محل قطع",
    "محل قطع غيار",
    "محل أدوات",
    "محل ادوات",
    "ادوات",
    "أدوات",
  ];
  if (partsSignals.some((w) => t.includes(w))) return "parts_tools";

  return "auto_repair";
}

function buildPlacesQuery(mode) {
  // IMPORTANT: keep query simple; Google Places understands it better than OR-heavy queries
  if (mode === "parts_tools") return "auto parts store";
  return "auto repair shop";
}

/* =========================================================
   LOCATION HELPERS
========================================================= */
function parseLatLng(input) {
  if (!input) return null;

  // object
  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return null;
  }

  // string: "lat,lng" or "lat lng"
  const s = String(input).trim();
  const m =
    s.match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/) ||
    s.match(/(-?\d+(\.\d+)?)\s+(-?\d+(\.\d+)?)/);
  if (!m) return null;

  const lat = Number(m[1]);
  const lng = Number(m[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function normalizeLocale(locale = "en") {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

function extractZip(text = "") {
  const m = String(text || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

// if user_location is string like "Louisville, KY" or object {city,state,country}
function safeCityText(userLocation) {
  if (!userLocation) return "";
  if (typeof userLocation === "string") {
    const v = userLocation.trim();
    if (!v || v.toLowerCase() === "global") return "";
    return v;
  }
  if (typeof userLocation === "object") {
    const city = userLocation.city || userLocation.locality || "";
    const region = userLocation.region || userLocation.state || "";
    const country = userLocation.country || "";
    return [city, region, country].filter(Boolean).join(", ").trim();
  }
  return "";
}

/* =========================================================
   PRICE LEVEL MAPPING
========================================================= */
function mapPriceLevel(level, locale = "en") {
  const v = String(level || "").toUpperCase().trim();
  if (!v || v.includes("UNSPECIFIED")) return { label: "", meaning: "" };

  const isAr = normalizeLocale(locale) === "ar";

  if (v.includes("INEXPENSIVE")) return { label: "$", meaning: isAr ? "اقتصادي" : "Inexpensive" };
  if (v.includes("MODERATE")) return { label: "$$", meaning: isAr ? "متوسط" : "Moderate" };
  if (v.includes("EXPENSIVE")) return { label: "$$$", meaning: isAr ? "مرتفع" : "Expensive" };
  if (v.includes("VERY_EXPENSIVE")) return { label: "$$$$", meaning: isAr ? "فاخر" : "Very expensive" };

  return { label: "", meaning: "" };
}

/* =========================================================
   GOOGLE PLACES (New) + CACHE
========================================================= */
const PLACES_CACHE = new Map();
const CACHE_TTL = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const TIMEOUT = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const PLACES_MAX = Number(process.env.PLACES_MAX_RESULTS || 5);

function cacheGet(key) {
  const hit = PLACES_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiry) {
    PLACES_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  PLACES_CACHE.set(key, { value, expiry: Date.now() + CACHE_TTL });
}

function makeCacheKey({ languageCode, textQuery, gps, locText }) {
  const g = gps ? `${Number(gps.lat).toFixed(3)},${Number(gps.lng).toFixed(3)}` : "no_gps";
  const l = locText ? normalizeText(locText).slice(0, 60) : "no_loc";
  return `${languageCode}::${textQuery}::${g}::${l}`;
}

async function placesSearchText({ textQuery, userLocation, locale, useGpsBias = true }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);

  const locText = safeCityText(userLocation);
  const cacheKey = makeCacheKey({ languageCode, textQuery, gps: useGpsBias ? gps : null, locText: useGpsBias ? "" : locText });

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const body = {
    textQuery,
    maxResultCount: Math.max(1, Math.min(PLACES_MAX, 10)),
    languageCode,
  };

  // GPS Bias (best)
  if (useGpsBias && gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius: Number(process.env.PLACES_RADIUS_METERS || 25000),
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const f = await ensureFetch();
    const res = await f("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.displayName",
          "places.formattedAddress",
          "places.googleMapsUri",
          "places.id",
          "places.rating",
          "places.userRatingCount",
          "places.nationalPhoneNumber",
          "places.websiteUri",
          "places.priceLevel",
        ].join(","),
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("Places non-OK:", res.status, data?.error?.message || data);
      return [];
    }

    const places = Array.isArray(data?.places) ? data.places : [];
    const mapped = places.slice(0, PLACES_MAX).map((p) => {
      const pl = p?.priceLevel ?? "";
      const mappedPL = mapPriceLevel(pl, locale);

      return {
        name: p?.displayName?.text || "",
        address: p?.formattedAddress || "",
        maps_url: p?.googleMapsUri || "",
        place_id: p?.id || "",
        rating: p?.rating ?? null,
        ratings_total: p?.userRatingCount ?? null,
        phone: p?.nationalPhoneNumber || "",
        website: p?.websiteUri || "",
        price_level: pl || "",
        price_label: mappedPL.label,       // "$$"
        price_meaning: mappedPL.meaning,   // "متوسط"
        source: "google_places_new",
      };
    });

    const deduped = uniqBy(mapped, (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`);
    cacheSet(cacheKey, deduped);
    return deduped;
  } catch (e) {
    console.error("Places error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchPlacesSmart({ query, userLocation, locale }) {
  const mode = detectModeFromText(query);
  const base = buildPlacesQuery(mode);

  // If user typed ZIP, help the search
  const zip = extractZip(query);

  // 1) GPS flow (best)
  const gps = parseLatLng(userLocation);
  if (gps) {
    const q1 = zip ? `${base} ${zip}` : base;
    const first = await placesSearchText({ textQuery: q1, userLocation, locale, useGpsBias: true });
    if (first && first.length) {
      return first.map((x) => ({ ...x, mode }));
    }

    // widen query slightly (still gps biased)
    const second = await placesSearchText({ textQuery: `${base} near me`, userLocation, locale, useGpsBias: true });
    return (second || []).map((x) => ({ ...x, mode }));
  }

  // 2) No GPS: use user_location city text
  const locText = safeCityText(userLocation);
  const qBase = zip ? `${base} ${zip}` : base;

  if (locText) {
    // Strategy A: "base in loc"
    const a = await placesSearchText({ textQuery: `${qBase} in ${locText}`, userLocation, locale, useGpsBias: false });
    if (a && a.length) return a.map((x) => ({ ...x, mode }));

    // Strategy B: "base loc"
    const b = await placesSearchText({ textQuery: `${qBase} ${locText}`, userLocation, locale, useGpsBias: false });
    if (b && b.length) return b.map((x) => ({ ...x, mode }));
  }

  // 3) No GPS + no locText: fallback to base only (less accurate but better than nothing)
  const c = await placesSearchText({ textQuery: qBase, userLocation, locale, useGpsBias: false });
  return (c || []).map((x) => ({ ...x, mode }));
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  loadKBOnce();

  const { locale = "en", allowPlaces = false, maxResults = 3 } = opts;

  // 1) Local KB (cheap)
  let verified_data = [];
  const q = String(userQuery || "").trim();

  if (q.length >= 2 && KB.length > 0) {
    const limit = Math.max(1, Math.min(Number(maxResults || 3), 10));

    const scored = KB
      .map((r) => ({ r, score: scoreMatch(q, recordToText(r)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    verified_data = uniqBy(
      scored.map(({ r, score }) => ({
        title: r.title || r.problem || r.name || "Verified item",
        score,
        source: r.__source || "data",
        causes: r.likely_causes || r.causes || "",
        checks: r.recommended_checks || r.checks || "",
        steps: r.steps || "",
        tags: r.tags || r.category || r.system || "",
      })),
      (x) => `${String(x.title).toLowerCase()}::${x.source}`
    );
  }

  // 2) Places (expensive) — only when allowed AND query is places-like
  let verified_workshops = [];
  if (allowPlaces && looksLikePlacesIntent(userQuery)) {
    verified_workshops = await searchPlacesSmart({ query: userQuery, userLocation, locale });
    verified_workshops = uniqBy(
      verified_workshops,
      (x) => x?.place_id || x?.maps_url || `${String(x?.name || "").toLowerCase()}::${String(x?.address || "").toLowerCase()}`
    );
  }

  return { verified_data, verified_workshops };
}
