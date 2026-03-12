// search.js — FixLens v4.0.0
// Clean + data-first + stable fields
// Goals:
// - Search internal KB first using manifest-selected files
// - Use Google Places only when places intent is clear and allowed
// - Return stable fields for service.js
// - Keep costs lower by avoiding unnecessary external calls

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const MANIFEST_PATH = path.join(DATA_DIR, "kb_manifest.json");

/* =========================================================
   FETCH SAFE
========================================================= */
let _fetch = globalThis.fetch;

async function ensureFetch() {
  if (_fetch) return _fetch;
  const mod = await import("node-fetch");
  _fetch = mod.default;
  return _fetch;
}

/* =========================================================
   CONFIG
========================================================= */
const PLACES_CACHE = new Map();
const KB_CACHE = new Map();

const CACHE_TTL_MS = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const PLACES_TIMEOUT_MS = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const PLACES_MAX_RESULTS = Number(process.env.PLACES_MAX_RESULTS || 5);
const DEFAULT_RADIUS_METERS = Number(process.env.PLACES_RADIUS_METERS || 25000);

/* =========================================================
   JSON / FILE HELPERS
========================================================= */
function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of arr || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

/* =========================================================
   MANIFEST
========================================================= */
let MANIFEST = null;

function loadManifestOnce() {
  if (MANIFEST) return MANIFEST;

  MANIFEST = safeReadJson(MANIFEST_PATH, null);

  if (!MANIFEST || !Array.isArray(MANIFEST.domains)) {
    MANIFEST = {
      version: "0",
      default_top_k: 10,
      domains: [],
    };
  }

  return MANIFEST;
}

/* =========================================================
   TEXT HELPERS
========================================================= */
function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(
      /[^a-z0-9\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\s\-\.\,]/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocale(locale = "en") {
  const value = String(locale || "").trim();
  if (!value || value.toLowerCase() === "auto") return "en";
  return value.split("-")[0].toLowerCase() || "en";
}

function hasAny(text = "", words = []) {
  const normalized = normalizeText(text);
  return words.some((word) => normalized.includes(normalizeText(word)));
}

function extractZip(text = "") {
  const match = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0] : "";
}

/* =========================================================
   LOCATION HELPERS
========================================================= */
function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object" && !Array.isArray(input)) {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude ?? input.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  const text = String(input || "").trim();
  const match = text.match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[3]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function safeCityText(userLocation) {
  if (!userLocation) return "";

  if (typeof userLocation === "string") {
    const value = userLocation.trim();
    if (!value || value.toLowerCase() === "global") return "";
    return value;
  }

  if (typeof userLocation === "object" && !Array.isArray(userLocation)) {
    const city =
      userLocation.city ||
      userLocation.locality ||
      userLocation.town ||
      userLocation.name ||
      "";

    const region =
      userLocation.region ||
      userLocation.state ||
      userLocation.adminArea ||
      "";

    const country = userLocation.country || "";

    return [city, region, country].filter(Boolean).join(", ").trim();
  }

  return "";
}

function extractLocationFromQuery(userQuery = "") {
  const query = String(userQuery || "").trim();
  if (!query) return "";

  const zip = extractZip(query);
  if (zip) return zip;

  const en = query.match(
    /\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z\s.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i
  );
  if (en) {
    const city = (en[1] || "").trim();
    const region = (en[2] || "").trim();
    const combined = [city, region].filter(Boolean).join(", ");
    if (combined.length >= 3) return combined;
  }

  const ar = query.match(
    /(?:\bفي\b|\bبال\b|\bبـ\b|\bب)(\s*[\u0600-\u06FFa-zA-Z,\s.\-]{3,50})/
  );
  if (ar?.[1]) {
    const candidate = ar[1]
      .replace(/[^\u0600-\u06FFa-zA-Z,\s.\-]/g, " ")
      .trim();
    if (candidate.length >= 3) return candidate;
  }

  return "";
}

/* =========================================================
   MANIFEST DOMAIN PICKING
========================================================= */
function pickDomainsForQuery(query = "") {
  const manifest = loadManifestOnce();
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const scored = (manifest.domains || [])
    .map((domain) => {
      const keywords = Array.isArray(domain.keywords) ? domain.keywords : [];
      let hits = 0;

      for (const keyword of keywords) {
        const normalizedKeyword = normalizeText(keyword);
        if (normalizedKeyword && normalizedQuery.includes(normalizedKeyword)) {
          hits += 1;
        }
      }

      const priority = Number(domain.priority || 0);
      const score = hits * 10 + priority;

      return { domain, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, 2).map((item) => item.domain);

  const meta = (manifest.domains || []).find(
    (domain) => String(domain.id || "") === "meta"
  );

  if (meta && !chosen.some((domain) => domain.id === "meta")) {
    chosen.push(meta);
  }

  return chosen;
}

/* =========================================================
   KB FILE LOADING
========================================================= */
function loadJsonFileAsRecords(fileName) {
  if (!fileName) return [];
  if (KB_CACHE.has(fileName)) return KB_CACHE.get(fileName);

  const filePath = path.join(DATA_DIR, fileName);
  const parsed = safeReadJson(filePath, null);

  let records = [];
  if (Array.isArray(parsed)) {
    records = parsed;
  } else if (parsed?.items && Array.isArray(parsed.items)) {
    records = parsed.items;
  } else if (parsed && typeof parsed === "object") {
    records = [parsed];
  }

  const normalized = records.map((record) => ({
    ...record,
    __source: fileName,
  }));

  KB_CACHE.set(fileName, normalized);
  return normalized;
}

function getKBForDomains(domains = []) {
  const files = uniqBy(
    domains.flatMap((domain) =>
      Array.isArray(domain.files) ? domain.files : []
    ),
    (file) => file
  );

  let output = [];
  for (const file of files) {
    output.push(...loadJsonFileAsRecords(file));
  }

  return output;
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function recordToText(record) {
  return normalizeText(
    [
      record.title,
      record.problem,
      record.symptom,
      record.description,
      record.likely_causes,
      record.recommended_checks,
      record.steps,
      record.tags,
      record.category,
      record.system,
      record.engine,
      record.issues,
      record.codes,
      record.code,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function scoreMatch(query, recordText) {
  const q = normalizeText(query);
  const text = normalizeText(recordText);

  if (!q || !text) return 0;

  let score = 0;

  if (text.includes(q)) score += 14;

  const tokens = q.split(" ").filter(Boolean);
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (text.includes(token)) score += 2;
  }

  const code = q.match(/\bp0\d{3}\b/i);
  if (code && text.includes(code[0].toLowerCase())) score += 8;

  return score;
}

function searchLocalKB(query, maxResults = 4) {
  const domains = pickDomainsForQuery(query);
  const kb = getKBForDomains(domains);

  if (!query || kb.length === 0) return [];

  const limit = Math.max(1, Math.min(Number(maxResults || 4), 10));

  const scored = kb
    .map((record) => ({
      record,
      score: scoreMatch(query, recordToText(record)),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return uniqBy(
    scored.map(({ record, score }) => ({
      title: record.title || record.problem || "Verified item",
      score,
      source: record.__source || "data",
      causes: record.likely_causes || record.causes || "",
      checks: record.recommended_checks || record.checks || "",
      steps: record.steps || "",
      tags: record.tags || record.category || record.system || "",
      raw: record,
    })),
    (item) => `${String(item.title).toLowerCase()}::${item.source}`
  );
}

/* =========================================================
   PLACES INTENT
========================================================= */
function looksLikePlacesIntent(query = "") {
  const text = String(query || "").toLowerCase();

  const shopWords = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "car repair",
    "near me",
    "nearby",
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
    "دلني",
  ];

  const partsWords = [
    "auto parts",
    "car parts",
    "parts store",
    "tool store",
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
    "ادوات",
    "أدوات",
    "price",
    "prices",
    "cost",
    "سعر",
    "اسعار",
    "تكلفة",
  ];

  return (
    shopWords.some((word) => text.includes(word)) ||
    partsWords.some((word) => text.includes(word))
  );
}

function detectModeFromText(query = "") {
  const text = String(query || "").toLowerCase();

  if (
    hasAny(text, [
      "tire",
      "tyre",
      "اطار",
      "إطار",
      "اطارات",
      "إطارات",
      "بنشر",
      "ترصيص",
    ])
  ) {
    return "tire";
  }

  if (hasAny(text, ["brake", "فرامل", "هوبات", "سفايف"])) {
    return "brake";
  }

  if (
    hasAny(text, [
      "auto parts",
      "car parts",
      "parts store",
      "tool store",
      "hardware store",
      "autozone",
      "o'reilly",
      "oreilly",
      "advance auto",
      "napa",
      "قطع غيار",
      "محل قطع",
      "محل أدوات",
      "ادوات",
      "أدوات",
      "price",
      "prices",
      "cost",
      "سعر",
      "اسعار",
      "تكلفة",
    ])
  ) {
    return "parts_tools";
  }

  if (hasAny(text, ["body shop", "سمكري", "حدادة سيارات", "صبغ", "دهان"])) {
    return "body_shop";
  }

  return "auto_repair";
}

function buildPlacesBaseQuery(mode) {
  if (mode === "parts_tools") return "auto parts store OR tool store OR hardware store";
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake shop OR brake repair";
  if (mode === "body_shop") return "auto body shop OR collision repair";
  return "auto repair shop OR mechanic";
}

/* =========================================================
   PRICE HELPERS
========================================================= */
function mapPriceLevel(level) {
  const value = String(level || "").toUpperCase().trim();

  if (!value || value.includes("UNSPECIFIED")) {
    return { label: "", meaning_ar: "", meaning_en: "" };
  }

  if (value.includes("INEXPENSIVE")) {
    return { label: "$", meaning_ar: "اقتصادي", meaning_en: "Budget" };
  }

  if (value.includes("MODERATE")) {
    return { label: "$$", meaning_ar: "متوسط", meaning_en: "Moderate" };
  }

  if (value.includes("EXPENSIVE")) {
    return { label: "$$$", meaning_ar: "مرتفع", meaning_en: "Expensive" };
  }

  if (value.includes("VERY_EXPENSIVE")) {
    return { label: "$$$$", meaning_ar: "فاخر", meaning_en: "Very Expensive" };
  }

  return { label: "", meaning_ar: "", meaning_en: "" };
}

function priceHint({ mode, priceLevelLabel, locale }) {
  const isAr = String(locale || "en").toLowerCase().startsWith("ar");

  if (!priceLevelLabel) return "";

  if (mode === "parts_tools") {
    return isAr
      ? `تصنيف سعر المتجر: ${priceLevelLabel} (تقريبي حسب Google)`
      : `Store price tier: ${priceLevelLabel} (approx, Google)`;
  }

  return isAr
    ? `تصنيف التكلفة: ${priceLevelLabel} (تقريبي حسب Google)`
    : `Cost tier: ${priceLevelLabel} (approx, Google)`;
}

/* =========================================================
   CACHE
========================================================= */
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
  PLACES_CACHE.set(key, {
    value,
    expiry: Date.now() + CACHE_TTL_MS,
  });
}

/* =========================================================
   GOOGLE PLACES
========================================================= */
async function searchPlaces({ query, userLocation, locale, radiusMeters }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);
  const mode = detectModeFromText(query);
  const baseQuery = buildPlacesBaseQuery(mode);

  let locationText = safeCityText(userLocation);
  if (!locationText) locationText = extractLocationFromQuery(query);

  const zip = extractZip(query);
  if (zip) locationText = zip;

  if (!gps && !locationText) return [];

  const textQuery = gps ? baseQuery : `${baseQuery} in ${locationText}`;
  const radius = Number(radiusMeters || DEFAULT_RADIUS_METERS);

  const cacheKey = `${languageCode}::${textQuery}::${
    gps
      ? `${gps.lat.toFixed(3)},${gps.lng.toFixed(3)}:${radius}`
      : `anchor:${locationText}`
  }`;

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const body = {
    textQuery,
    maxResultCount: Math.max(1, Math.min(PLACES_MAX_RESULTS, 10)),
    languageCode,
  };

  if (gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius,
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);

  try {
    const fetchFn = await ensureFetch();

    const response = await fetchFn(
      "https://places.googleapis.com/v1/places:searchText",
      {
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
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Places non-OK:", response.status, data?.error?.message || data);
      return [];
    }

    const places = Array.isArray(data?.places) ? data.places : [];

    const mapped = places.slice(0, PLACES_MAX_RESULTS).map((place) => {
      const priceLevel = place?.priceLevel ?? "";
      const price = mapPriceLevel(priceLevel);

      return {
        name: place?.displayName?.text || "",
        address: place?.formattedAddress || "",
        maps_url: place?.googleMapsUri || "",
        website: place?.websiteUri || "",
        place_id: place?.id || "",
        rating: place?.rating ?? null,
        ratings_total: place?.userRatingCount ?? null,
        phone: place?.nationalPhoneNumber || "",
        price_level: priceLevel || "",
        price_label: price.label,
        price_meaning_ar: price.meaning_ar,
        price_meaning_en: price.meaning_en,
        price_hint: priceHint({
          mode,
          priceLevelLabel: price.label,
          locale,
        }),
        mode,
        location_anchor: gps ? "gps" : String(locationText),
        source: "google_places_new",
      };
    });

    const deduped = uniqBy(
      mapped,
      (item) => item.place_id || item.maps_url || `${item.name}::${item.address}`
    );

    cacheSet(cacheKey, deduped);
    return deduped;
  } catch (error) {
    console.error("Places error:", error?.message || error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  const {
    locale = "en",
    allowPlaces = false,
    maxResults = 4,
    placesRadiusMeters,
  } = opts;

  const query = String(userQuery || "").trim();

  const verified_data =
    query.length >= 2 ? searchLocalKB(query, maxResults) : [];

  let verified_workshops = [];

  if (allowPlaces && looksLikePlacesIntent(query)) {
    verified_workshops = await searchPlaces({
      query,
      userLocation,
      locale,
      radiusMeters: placesRadiusMeters,
    });
  }

  return {
    verified_data,
    verified_workshops,
  };
}
