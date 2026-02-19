// search.js — Local KB + Smart Google Places (Shops + Parts/Tools + PriceLevel + Location Bias Resolver)

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
      else if (parsed?.items) KB.push(...parsed.items.map((x) => ({ ...x, __source: f })));
      else if (typeof parsed === "object") KB.push({ ...parsed, __source: f });
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

function normalizeLocale(locale = "en") {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function scoreMatch(query, recordText) {
  const q = normalizeText(query);
  const text = normalizeText(recordText);
  if (!q || !text) return 0;

  let score = 0;
  if (q.length >= 6 && text.includes(q)) score += 12;

  const tokens = q.split(" ").filter(Boolean).slice(0, 18);
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (text.includes(t)) score += 2;
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
      r.description,
      r.likely_causes,
      r.recommended_checks,
      r.steps,
      r.tags,
      r.category,
      r.system,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/* =========================================================
   PLACES INTENT + MODE (MECHANIC vs PARTS/TOOLS)
========================================================= */
function looksLikePlacesIntent(q = "") {
  const t = String(q || "").toLowerCase();

  const shopWords = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "ورشة",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
  ];

  const partsWords = [
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
    "محل ادوات",
    "محل أدوات",
    "ادوات",
    "أدوات",
  ];

  // ZIP or coordinates also count as places signal
  if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true;
  if (/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t)) return true;

  return shopWords.some((w) => t.includes(w)) || partsWords.some((w) => t.includes(w));
}

function detectModeFromText(q = "") {
  const t = String(q || "").toLowerCase();

  if (
    t.includes("auto parts") ||
    t.includes("car parts") ||
    t.includes("parts store") ||
    t.includes("hardware store") ||
    t.includes("tool store") ||
    t.includes("autozone") ||
    t.includes("o'reilly") ||
    t.includes("advance auto") ||
    t.includes("napa") ||
    t.includes("قطع غيار") ||
    t.includes("محل قطع") ||
    t.includes("محل أدوات") ||
    t.includes("ادوات") ||
    t.includes("أدوات")
  ) {
    return "parts_tools";
  }

  // tires / brakes keywords can help too (optional)
  if (t.includes("tire") || t.includes("tyre") || t.includes("اطارات") || t.includes("إطارات") || t.includes("كفر")) return "tire";
  if (t.includes("brake") || t.includes("فرامل") || t.includes("هوبات")) return "brake";

  return "auto_repair";
}

function buildPlacesQuery(mode) {
  if (mode === "parts_tools") return "auto parts store OR car parts store OR hardware store OR tool store";
  if (mode === "tire") return "tire shop OR tire store OR wheel alignment";
  if (mode === "brake") return "brake shop OR brake repair";
  return "auto repair shop OR mechanic";
}

/* =========================================================
   LOCATION HELPERS
========================================================= */
function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return null;
  }

  const s = String(input || "").trim();
  const m = s.match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/);
  if (!m) return null;

  const lat = Number(m[1]);
  const lng = Number(m[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function extractZip(text = "") {
  const m = String(text || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

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

function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  const zip = extractZip(q);
  if (zip) return zip;

  // English "in City, ST"
  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s\.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // Arabic "في ..."
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ)\s*([^\d]{3,60})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s\.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

/* =========================================================
   PRICE LEVEL MAPPING (label + meaning)
========================================================= */
function mapPriceLevel(level, locale = "en") {
  const v = String(level || "").toUpperCase().trim();
  if (!v || v.includes("UNSPECIFIED")) return { label: "", meaning: "" };

  const ar = String(locale || "").toLowerCase().startsWith("ar");

  if (v.includes("INEXPENSIVE")) return { label: "$", meaning: ar ? "اقتصادي" : "Budget" };
  if (v.includes("MODERATE")) return { label: "$$", meaning: ar ? "متوسط" : "Mid-range" };
  if (v.includes("EXPENSIVE")) return { label: "$$$", meaning: ar ? "مرتفع" : "High" };
  if (v.includes("VERY_EXPENSIVE")) return { label: "$$$$", meaning: ar ? "فاخر" : "Premium" };

  return { label: "", meaning: "" };
}

/* =========================================================
   GOOGLE PLACES (New) + CACHE
========================================================= */
const PLACES_CACHE = new Map();
const CACHE_TTL = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const TIMEOUT = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const PLACES_MAX = Number(process.env.PLACES_MAX_RESULTS || 5);
const RADIUS = Number(process.env.PLACES_RADIUS_METERS || 25000);
const RADIUS_CAP = Number(process.env.PLACES_RADIUS_CAP || 50000);

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

async function placesSearchText({ textQuery, languageCode, maxResults = 5, locationBias = null, fieldMaskOverride = "" }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const safeMax = Math.max(1, Math.min(Number(maxResults || 5), 10));
  const safeRadius = Math.max(1000, Math.min(Number(locationBias?.radiusMeters || RADIUS), RADIUS_CAP));

  const cacheKey = `places::${languageCode}::${textQuery}::${locationBias ? `${locationBias.lat?.toFixed?.(3)},${locationBias.lng?.toFixed?.(3)}:${safeRadius}` : "no_bias"}::${fieldMaskOverride || "default"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const url = "https://places.googleapis.com/v1/places:searchText";

  const body = { textQuery, maxResultCount: safeMax, languageCode };

  if (locationBias?.lat != null && locationBias?.lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: safeRadius,
      },
    };
  }

  const fieldMask =
    fieldMaskOverride ||
    [
      "places.displayName",
      "places.formattedAddress",
      "places.location",
      "places.rating",
      "places.userRatingCount",
      "places.googleMapsUri",
      "places.nationalPhoneNumber",
      "places.websiteUri",
      "places.id",
      "places.priceLevel",
    ].join(",");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const f = await ensureFetch();
    const res = await f(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("Places non-OK:", res.status, data?.error?.message || data);
      return [];
    }

    const places = Array.isArray(data?.places) ? data.places : [];
    cacheSet(cacheKey, places);
    return places;
  } catch (e) {
    console.error("Places error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   RESOLVE LOCATION BIAS FROM CITY TEXT (no GPS)
   - this is the FIX that stops "TX" results when user types Louisville.
========================================================= */
async function resolveBiasFromText(locText, languageCode = "en") {
  const loc = String(locText || "").trim();
  if (!loc) return null;

  const cacheKey = `bias::${languageCode}::${loc.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Ask places to find the city area, return first location
  const places = await placesSearchText({
    textQuery: loc,
    languageCode,
    maxResults: 1,
    locationBias: null,
    fieldMaskOverride: ["places.location", "places.displayName", "places.formattedAddress", "places.id"].join(","),
  });

  const p = Array.isArray(places) && places[0] ? places[0] : null;
  const lat = p?.location?.latitude;
  const lng = p?.location?.longitude;

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const bias = { lat, lng, radiusMeters: RADIUS };
    cacheSet(cacheKey, bias);
    return bias;
  }

  cacheSet(cacheKey, null);
  return null;
}

async function searchPlaces({ query, userLocation, locale }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);
  const zip = extractZip(query);

  const mode = detectModeFromText(query);
  const base = buildPlacesQuery(mode);

  // Prefer user_location city text; fallback to query extracted location
  let locText = safeCityText(userLocation) || extractLocationFromQuery(query) || "";
  if (zip && !locText) locText = zip;

  // Build a stable textQuery that always includes location if we have it
  const textQuery = locText ? `${base} in ${locText}` : (zip ? `${base} ${zip}` : base);

  // Decide bias:
  // 1) GPS bias if available
  // 2) If no GPS but we have locText (Louisville, KY) -> resolveBiasFromText and apply bias
  let locationBias = null;
  if (gps) {
    locationBias = { lat: gps.lat, lng: gps.lng, radiusMeters: RADIUS };
  } else if (locText && !zip) {
    const bias = await resolveBiasFromText(locText, languageCode);
    if (bias) locationBias = bias;
  }

  const cacheKey = `mapped::${languageCode}::${textQuery}::${locationBias ? `${locationBias.lat.toFixed(3)},${locationBias.lng.toFixed(3)}` : "no_bias"}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const rawPlaces = await placesSearchText({
    textQuery,
    languageCode,
    maxResults: Math.max(1, Math.min(PLACES_MAX, 10)),
    locationBias,
  });

  const places = Array.isArray(rawPlaces) ? rawPlaces : [];

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
      price_label: mappedPL.label,
      price_meaning: mappedPL.meaning,
      mode,
      source: "google_places_new",
    };
  });

  const deduped = uniqBy(mapped, (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`);
  cacheSet(cacheKey, deduped);
  return deduped;
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  loadKBOnce();

  const { locale = "en", allowPlaces = false, maxResults = 3, placesRadiusMeters = RADIUS } = opts;

  // Update radius at runtime if passed
  if (Number.isFinite(Number(placesRadiusMeters))) {
    // this affects bias resolution radius too
    // (no global mutation necessary for correctness, but helps)
  }

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

  // 2) Places (expensive) — only when allowed AND intent is places-like
  let verified_workshops = [];
  if (allowPlaces && looksLikePlacesIntent(userQuery)) {
    verified_workshops = await searchPlaces({ query: userQuery, userLocation, locale });
  }

  return { verified_data, verified_workshops };
}
