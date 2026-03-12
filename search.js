// search.js — FixLens v3.0.1
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
   MANIFEST
========================================================= */
let MANIFEST = null;

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

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
function normalizeText(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\s\-\.\,]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocale(locale = "en") {
  const v = String(locale || "").trim();
  if (!v || v.toLowerCase() === "auto") return "en";
  return v.split("-")[0].toLowerCase() || "en";
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

function hasAny(text = "", words = []) {
  const t = normalizeText(text);
  return words.some((w) => t.includes(normalizeText(w)));
}

function extractZip(text = "") {
  const m = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return m ? m[0] : "";
}

/* =========================================================
   LOCATION HELPERS
========================================================= */
function safeCityText(userLocation) {
  if (!userLocation) return "";

  if (typeof userLocation === "string") {
    const v = userLocation.trim();
    if (!v) return "";
    if (v.toLowerCase() === "global") return "";
    return v;
  }

  if (typeof userLocation === "object") {
    const city = userLocation.city || userLocation.locality || userLocation.town || "";
    const region = userLocation.region || userLocation.state || userLocation.adminArea || "";
    const country = userLocation.country || "";
    return [city, region, country].filter(Boolean).join(", ").trim();
  }

  return "";
}

function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude ?? input.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  const s = String(input || "").trim();
  const m = s.match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/);
  if (!m) return null;

  const lat = Number(m[1]);
  const lng = Number(m[3]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng };
}

function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  const zip = extractZip(q);
  if (zip) return zip;

  const en = q.match(/\bin\s+([A-Za-z][A-Za-z\s.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (en) {
    const city = (en[1] || "").trim();
    const region = (en[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  const ar = q.match(/(?:\bفي\b|\bبال\b|\bبـ\b|\bب)(\s*[\u0600-\u06FFa-zA-Z,\s.\-]{3,50})/);
  if (ar?.[1]) {
    const cand = ar[1].replace(/[^\u0600-\u06FFa-zA-Z,\s.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

/* =========================================================
   MANIFEST DOMAIN PICKING
========================================================= */
function pickDomainsForQuery(query = "") {
  const manifest = loadManifestOnce();
  const q = normalizeText(query);
  if (!q) return [];

  const scored = (manifest.domains || [])
    .map((d) => {
      const kw = Array.isArray(d.keywords) ? d.keywords : [];
      let hits = 0;

      for (const w of kw) {
        const ww = normalizeText(w);
        if (ww && q.includes(ww)) hits += 1;
      }

      const priority = Number(d.priority || 0);
      const score = hits * 10 + priority;

      return { domain: d, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, 2).map((x) => x.domain);

  const meta = (manifest.domains || []).find((d) => String(d.id || "") === "meta");
  if (meta && !chosen.some((c) => c.id === "meta")) {
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

  const normalized = records.map((x) => ({ ...x, __source: fileName }));
  KB_CACHE.set(fileName, normalized);
  return normalized;
}

function getKBForDomains(domains = []) {
  const files = uniqBy(
    domains.flatMap((d) => (Array.isArray(d.files) ? d.files : [])),
    (x) => x
  );

  let out = [];
  for (const f of files) {
    out.push(...loadJsonFileAsRecords(f));
  }
  return out;
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function recordToText(r) {
  return normalizeText(
    [
      r.title,
      r.problem,
      r.symptom,
      r.description,
      r.likely_causes,
      r.recommended_checks,
      r.steps,
      r.tags,
      r.category,
      r.system,
      r.engine,
      r.issues,
      r.codes,
      r.code,
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
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (text.includes(t)) score += 2;
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
    .map((r) => ({ r, score: scoreMatch(query, recordToText(r)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return uniqBy(
    scored.map(({ r, score }) => ({
      title: r.title || r.problem || "Verified item",
      score,
      source: r.__source || "data",
      causes: r.likely_causes || r.causes || "",
      checks: r.recommended_checks || r.checks || "",
      steps: r.steps || "",
      tags: r.tags || r.category || r.system || "",
      raw: r,
    })),
    (x) => `${String(x.title).toLowerCase()}::${x.source}`
  );
}

/* =========================================================
   PLACES INTENT
========================================================= */
function looksLikePlacesIntent(q = "") {
  const t = String(q || "").toLowerCase();

  const shopWords = [
    "mechanic", "garage", "auto repair", "repair shop", "car repair", "near me", "nearby",
    "closest", "address", "location", "map", "google maps", "workshop",
    "ورشة", "ورش", "ميكانيك", "ميكانيكي", "كراج", "اقرب", "أقرب", "عنوان", "موقع",
    "خرائط", "وين اصلح", "وين أُصلّح", "وين اروح", "دلني"
  ];

  const partsWords = [
    "auto parts", "car parts", "parts store", "tool store", "hardware store",
    "autozone", "o'reilly", "oreilly", "advance auto", "napa",
    "قطع غيار", "محل قطع", "محل قطع غيار", "محل ادوات", "محل أدوات", "ادوات", "أدوات",
    "price", "prices", "cost", "سعر", "اسعار", "تكلفة"
  ];

  return shopWords.some((w) => t.includes(w)) || partsWords.some((w) => t.includes(w));
}

function detectModeFromText(q = "") {
  const t = String(q || "").toLowerCase();

  if (hasAny(t, ["tire", "tyre", "اطار", "إطار", "اطارات", "إطارات", "بنشر", "ترصيص"])) {
    return "tire";
  }

  if (hasAny(t, ["brake", "فرامل", "هوبات", "سفايف"])) {
    return "brake";
  }

  if (
    hasAny(t, [
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

  if (hasAny(t, ["body shop", "سمكري", "حدادة سيارات", "صبغ", "دهان"])) {
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
   PRICE MAPPING
========================================================= */
function mapPriceLevel(level) {
  const v = String(level || "").toUpperCase().trim();
  if (!v || v.includes("UNSPECIFIED")) {
    return { label: "", meaning_ar: "", meaning_en: "" };
  }

  if (v.includes("INEXPENSIVE")) {
    return { label: "$", meaning_ar: "اقتصادي", meaning_en: "Budget" };
  }
  if (v.includes("MODERATE")) {
    return { label: "$$", meaning_ar: "متوسط", meaning_en: "Moderate" };
  }
  if (v.includes("EXPENSIVE")) {
    return { label: "$$$", meaning_ar: "مرتفع", meaning_en: "Expensive" };
  }
  if (v.includes("VERY_EXPENSIVE")) {
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

  let locText = safeCityText(userLocation);
  if (!locText) locText = extractLocationFromQuery(query);

  const zip = extractZip(query);
  if (zip) locText = zip;

  if (!gps && !locText) return [];

  const textQuery = gps ? baseQuery : `${baseQuery} in ${locText}`;
  const radius = Number(radiusMeters || DEFAULT_RADIUS_METERS);

  const cacheKey = `${languageCode}::${textQuery}::${
    gps ? `${gps.lat.toFixed(3)},${gps.lng.toFixed(3)}:${radius}` : `anchor:${locText}`
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

    const mapped = places.slice(0, PLACES_MAX_RESULTS).map((p) => {
      const pl = p?.priceLevel ?? "";
      const plMap = mapPriceLevel(pl);

      return {
        name: p?.displayName?.text || "",
        address: p?.formattedAddress || "",
        maps_url: p?.googleMapsUri || "",
        website: p?.websiteUri || "",
        place_id: p?.id || "",
        rating: p?.rating ?? null,
        ratings_total: p?.userRatingCount ?? null,
        phone: p?.nationalPhoneNumber || "",
        price_level: pl || "",
        price_label: plMap.label,
        price_meaning_ar: plMap.meaning_ar,
        price_meaning_en: plMap.meaning_en,
        price_hint: priceHint({ mode, priceLevelLabel: plMap.label, locale }),
        mode,
        location_anchor: gps ? "gps" : String(locText),
        source: "google_places_new",
      };
    });

    const deduped = uniqBy(
      mapped,
      (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`
    );

    cacheSet(cacheKey, deduped);
    return deduped;
  } catch (e) {
    console.error("Places error:", e?.message || e);
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

  const q = String(userQuery || "").trim();

  const verified_data = q.length >= 2 ? searchLocalKB(q, maxResults) : [];

  let verified_workshops = [];
  if (allowPlaces && looksLikePlacesIntent(q)) {
    verified_workshops = await searchPlaces({
      query: q,
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
