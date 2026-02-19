// search.js — Local KB + Smart Google Places (Workshops + Parts/Tools + PriceLevel hints)

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
      else if (typeof parsed === "object" && parsed) KB.push({ ...parsed, __source: f });
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
  if (text.includes(q)) score += 10;

  const tokens = q.split(" ").filter(Boolean).slice(0, 24);
  for (const t of tokens) if (text.includes(t)) score += 2;

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
   PLACES INTENT + MODE
========================================================= */
function looksLikePlacesIntent(q = "") {
  const t = String(q || "").toLowerCase();

  const shopWords = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "tire shop",
    "tyre shop",
    "near me",
    "closest",
    "nearby",
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
    "اطارات",
    "إطارات",
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

  // ZIP => likely places
  if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true;

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
    t.includes("tools store") ||
    t.includes("autozone") ||
    t.includes("o'reilly") ||
    t.includes("oreilly") ||
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

  // tires
  if (t.includes("tire") || t.includes("tyre") || t.includes("إطارات") || t.includes("اطارات")) return "tire";

  return "auto_repair";
}

function buildPlacesQuery(mode) {
  if (mode === "parts_tools") return "auto parts store OR tool store OR hardware store";
  if (mode === "tire") return "tire shop OR wheel alignment";
  return "auto repair shop OR mechanic";
}

/* =========================================================
   LOCATION HELPERS (CRITICAL FIX FOR TX ISSUE)
========================================================= */
function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return null;
  }

  // If string "lat,lng"
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

function extractZip(text = "") {
  const m = String(text || "").match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : "";
}

function safeCityText(userLocation) {
  if (!userLocation) return "";
  if (typeof userLocation === "string") {
    const v = userLocation.trim();
    if (!v) return "";
    if (v.toLowerCase() === "global") return "";
    return v;
  }
  if (typeof userLocation === "object") {
    const city = userLocation.city || userLocation.locality || "";
    const region = userLocation.region || userLocation.state || "";
    const country = userLocation.country || "";
    const combo = [city, region, country].filter(Boolean).join(", ");
    return combo.trim();
  }
  return "";
}

// Extract location from user query when user typed "Louisville Kentucky" or "in Louisville, KY"
function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  // ZIP only or includes ZIP
  const zip = extractZip(q);
  if (zip) return zip;

  // English: "in Louisville, KY"
  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1 && (m1[1] || m1[2])) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // If user wrote just "Louisville Kentucky" (no "in")
  if (/^[A-Za-z][A-Za-z\s.\-']{2,}$/.test(q) && q.split(" ").length <= 4) {
    return q;
  }

  // Arabic: "في لوفل كنتاكي"
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ)(\s*[^\d]{3,60})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

/* =========================================================
   PRICE LEVEL MAPPING + SMART PRICE HINT (approx, not real prices)
========================================================= */
function mapPriceLevel(level) {
  const v = String(level || "").toUpperCase().trim();
  if (!v || v.includes("UNSPECIFIED")) return { label: "", meaning_ar: "", meaning_en: "" };

  if (v.includes("INEXPENSIVE")) return { label: "$", meaning_ar: "اقتصادي", meaning_en: "Inexpensive" };
  if (v.includes("MODERATE")) return { label: "$$", meaning_ar: "متوسط", meaning_en: "Moderate" };
  if (v.includes("EXPENSIVE")) return { label: "$$$", meaning_ar: "مرتفع", meaning_en: "Expensive" };
  if (v.includes("VERY_EXPENSIVE")) return { label: "$$$$", meaning_ar: "فاخر", meaning_en: "Very expensive" };

  return { label: "", meaning_ar: "", meaning_en: "" };
}

// NOTE: Google PriceLevel is NOT actual prices.
// We only give a "hint" and keep it non-absolute.
function priceHintFromPriceLevel({ priceLevel, mode, locale }) {
  const lang = normalizeLocale(locale) === "ar" ? "ar" : "en";
  const pl = mapPriceLevel(priceLevel);

  if (!pl.label) return "";

  // Very light heuristic hints (do NOT claim exact prices)
  if (mode === "parts_tools") {
    return lang === "ar"
      ? `${pl.label} (${pl.meaning_ar}) — عادةً متجر قطع الغيار يكون ضمن هذا المستوى`
      : `${pl.label} (${pl.meaning_en}) — typical parts stores fall around this level`;
  }

  if (mode === "tire") {
    return lang === "ar"
      ? `${pl.label} (${pl.meaning_ar}) — مستوى أسعار تقريبي للخدمة/المتجر`
      : `${pl.label} (${pl.meaning_en}) — rough price level for the shop/service`;
  }

  return lang === "ar"
    ? `${pl.label} (${pl.meaning_ar}) — مستوى أسعار تقريبي`
    : `${pl.label} (${pl.meaning_en}) — rough price level`;
}

/* =========================================================
   GOOGLE PLACES (New) + CACHE
========================================================= */
const PLACES_CACHE = new Map();
const CACHE_TTL = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const TIMEOUT = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const PLACES_MAX = Number(process.env.PLACES_MAX_RESULTS || 5);
const RADIUS_METERS = Number(process.env.PLACES_RADIUS_METERS || 25000);

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

function makeCacheKey({ languageCode, textQuery, gps }) {
  return `${languageCode}::${textQuery}::${gps ? `${gps.lat.toFixed(3)},${gps.lng.toFixed(3)}` : "no_gps"}`;
}

async function placesSearchText({ textQuery, languageCode, gps }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const maxResultCount = Math.max(1, Math.min(PLACES_MAX, 10));

  const cacheKey = makeCacheKey({ languageCode, textQuery, gps });
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const body = { textQuery, maxResultCount, languageCode };

  if (gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius: Math.max(1000, Math.min(RADIUS_METERS, 50000)),
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
    cacheSet(cacheKey, places);
    return places;
  } catch (e) {
    console.error("Places error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function searchPlaces({ query, userLocation, locale }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(query);
  const baseQuery = buildPlacesQuery(mode);

  // CRITICAL: when no GPS, we MUST include a location text to avoid random states
  let locText = safeCityText(userLocation);
  if (!locText) locText = extractLocationFromQuery(query);

  // If user typed ZIP somewhere, it's still useful
  const zip = extractZip(query);

  // Build a strong textQuery:
  // 1) If GPS available: baseQuery is fine (locationBias will bias)
  // 2) If no GPS: we MUST do "in <loc>" or "<zip>"
  let textQuery = baseQuery;

  if (!gps) {
    if (locText) textQuery = `${baseQuery} in ${locText}`;
    else if (zip) textQuery = `${baseQuery} ${zip}`;
    else {
      // No GPS + no location text => refuse to call places (avoid wrong states)
      return [];
    }
  }

  // Call Places
  const rawPlaces = await placesSearchText({ textQuery, languageCode, gps });

  const mapped = (rawPlaces || []).slice(0, PLACES_MAX).map((p) => {
    const pl = p?.priceLevel ?? "";
    const price_hint = priceHintFromPriceLevel({ priceLevel: pl, mode, locale });

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
      price_hint, // ✅ smart hint (NOT a real price)
      mode,       // parts_tools | tire | auto_repair
      source: "google_places_new",
    };
  });

  return uniqBy(mapped, (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`);
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  loadKBOnce();

  const {
    locale = "en",
    allowPlaces = false,
    maxResults = 3,
    // ✅ optional: force places to use typed text only
    placesQueryOverride = "",
  } = opts;

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

  // 2) Places (expensive)
  let verified_workshops = [];
  const placesQuery = String(placesQueryOverride || "").trim() || q;

  if (allowPlaces && looksLikePlacesIntent(placesQuery)) {
    verified_workshops = await searchPlaces({
      query: placesQuery,
      userLocation,
      locale,
    });
  }

  return { verified_data, verified_workshops };
}
