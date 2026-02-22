// search.js — FixLens v2.0 (Manifest-based KB + Strong Places + Stable fields)
// - Loads ONLY relevant data files (by domain) instead of loading all /data
// - Better scoring + safer parsing
// - Places returns stable fields for service.js formatting

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const MANIFEST_PATH = path.join(DATA_DIR, "kb_manifest.json");

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
   MANIFEST LOADER
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
    MANIFEST = { version: "0", default_top_k: 10, domains: [] };
  }
  return MANIFEST;
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
  if (!v || v.toLowerCase() === "auto") return "en";
  return v.split("-")[0].toLowerCase() || "en";
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
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
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
  const m = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return m ? m[0] : "";
}

function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  const zip = extractZip(q);
  if (zip) return zip;

  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s\.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ\b|\bب)(\s*[\u0600-\u06FFa-zA-Z,\s\.\-]{3,40})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s\.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

/* =========================================================
   DOMAIN SELECTION (KB)
========================================================= */
function pickDomainsForQuery(query = "") {
  const m = loadManifestOnce();
  const q = normalizeText(query);
  if (!q) return [];

  // score domains by keyword hits + priority
  const scored = (m.domains || [])
    .map((d) => {
      const kw = Array.isArray(d.keywords) ? d.keywords : [];
      let hits = 0;
      for (const w of kw) {
        const ww = normalizeText(w);
        if (ww && q.includes(ww)) hits += 1;
      }
      const pr = Number(d.priority || 0);
      // weight: hits dominate, then priority
      const score = hits * 10 + pr;
      return { d, score, hits };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Always include "meta" if present (cause/actions)
  const meta = (m.domains || []).find((d) => String(d.id || "") === "meta");

  const chosen = scored.slice(0, 2).map((x) => x.d);
  if (meta && !chosen.some((c) => c.id === "meta")) chosen.push(meta);

  return chosen;
}

/* =========================================================
   KB FILE LOADER (per-domain, cached)
========================================================= */
const KB_CACHE = new Map(); // key: filename -> parsed records array

function loadJsonFileAsRecords(fileName) {
  if (!fileName) return [];
  if (KB_CACHE.has(fileName)) return KB_CACHE.get(fileName);

  const p = path.join(DATA_DIR, fileName);
  const parsed = safeReadJson(p, null);

  let records = [];
  // Accept: array, {items:[]}, or object
  if (Array.isArray(parsed)) records = parsed;
  else if (parsed?.items && Array.isArray(parsed.items)) records = parsed.items;
  else if (parsed && typeof parsed === "object") records = [parsed];

  // attach source
  records = records.map((x) => ({ ...x, __source: fileName }));

  KB_CACHE.set(fileName, records);
  return records;
}

function getKBForDomains(domains = []) {
  const files = uniqBy(
    domains.flatMap((d) => (Array.isArray(d.files) ? d.files : [])),
    (x) => x
  );
  let out = [];
  for (const f of files) out.push(...loadJsonFileAsRecords(f));
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
      r.engine, // sometimes you have engine field
      r.issues, // patterns may have issues
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

  // extra boost for codes like P0171, P0300
  const code = q.match(/\bp0\d{3}\b/i);
  if (code && text.includes(code[0].toLowerCase())) score += 8;

  return score;
}

/* =========================================================
   PLACES INTENT + MODE
========================================================= */
function looksLikePlacesIntent(q = "") {
  const t = String(q || "").toLowerCase();

  const shopWords = [
    "mechanic","garage","auto repair","repair shop","car repair","near me","nearby","closest",
    "address","location","map","google maps","workshop",
    "ورشة","ورش","ميكانيك","ميكانيكي","كراج","اقرب","أقرب","عنوان","موقع","خرائط","وين اصلح","وين أُصلّح","وين اروح","دلّني"
  ];

  const partsWords = [
    "auto parts","car parts","parts store","tool store","hardware store",
    "autozone","o'reilly","oreilly","advance auto","napa",
    "قطع غيار","محل قطع","محل قطع غيار","محل ادوات","محل أدوات","ادوات","أدوات"
  ];

  return shopWords.some((w) => t.includes(w)) || partsWords.some((w) => t.includes(w));
}

function detectModeFromText(q = "") {
  const t = String(q || "").toLowerCase();
  if (t.includes("tire") || t.includes("tyre") || t.includes("اطار") || t.includes("إطار") || t.includes("اطارات") || t.includes("إطارات")) return "tire";
  if (t.includes("brake") || t.includes("فرامل")) return "brake";
  if (
    t.includes("auto parts") || t.includes("car parts") || t.includes("parts store") ||
    t.includes("hardware store") || t.includes("tool store") ||
    t.includes("autozone") || t.includes("o'reilly") || t.includes("oreilly") ||
    t.includes("advance auto") || t.includes("napa") ||
    t.includes("قطع غيار") || t.includes("محل قطع") || t.includes("محل أدوات") || t.includes("ادوات") || t.includes("أدوات")
  ) return "parts_tools";
  return "auto_repair";
}

function buildPlacesQuery(mode) {
  if (mode === "parts_tools") return "auto parts store OR tool store OR hardware store";
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake shop OR brake repair";
  return "auto repair shop OR mechanic";
}

/* =========================================================
   PRICE LEVEL MAPPING
========================================================= */
function mapPriceLevel(level) {
  const v = String(level || "").toUpperCase().trim();
  if (!v || v.includes("UNSPECIFIED")) return { label: "", meaning_ar: "", meaning_en: "" };

  if (v.includes("INEXPENSIVE")) return { label: "$", meaning_ar: "اقتصادي", meaning_en: "Budget" };
  if (v.includes("MODERATE")) return { label: "$$", meaning_ar: "متوسط", meaning_en: "Moderate" };
  if (v.includes("EXPENSIVE")) return { label: "$$$", meaning_ar: "مرتفع", meaning_en: "Expensive" };
  if (v.includes("VERY_EXPENSIVE")) return { label: "$$$$", meaning_ar: "فاخر", meaning_en: "Very Expensive" };

  return { label: "", meaning_ar: "", meaning_en: "" };
}

function priceHint({ mode, priceLevelLabel, locale }) {
  const isAr = String(locale || "en").toLowerCase().startsWith("ar");
  if (!priceLevelLabel) return "";
  if (mode === "parts_tools") {
    return isAr ? `تصنيف سعر المتجر: ${priceLevelLabel} (تقريبي حسب Google)` : `Store price tier: ${priceLevelLabel} (approx, Google)`;
  }
  return isAr ? `تصنيف التكلفة: ${priceLevelLabel} (تقريبي حسب Google)` : `Cost tier: ${priceLevelLabel} (approx, Google)`;
}

/* =========================================================
   GOOGLE PLACES (New) + CACHE
========================================================= */
const PLACES_CACHE = new Map();
const CACHE_TTL = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const TIMEOUT = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const PLACES_MAX = Number(process.env.PLACES_MAX_RESULTS || 5);
const RADIUS_METERS_DEFAULT = Number(process.env.PLACES_RADIUS_METERS || 25000);

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

async function searchPlaces({ query, userLocation, locale, radiusMeters }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);
  const mode = detectModeFromText(query);
  const base = buildPlacesQuery(mode);

  let locText = safeCityText(userLocation);
  if (!locText) locText = extractLocationFromQuery(query);

  const zip = extractZip(query);
  if (zip) locText = zip;

  // No GPS and no anchor => no call (prevents random far results)
  if (!gps && !locText) return [];

  const textQuery = !gps ? `${base} in ${locText}` : base;
  const RADIUS_METERS = Number(radiusMeters || RADIUS_METERS_DEFAULT);

  const cacheKey = `${languageCode}::${textQuery}::${gps ? `${gps.lat.toFixed(3)},${gps.lng.toFixed(3)}:${RADIUS_METERS}` : `no_gps:${locText}`}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const body = {
    textQuery,
    maxResultCount: Math.max(1, Math.min(PLACES_MAX, 10)),
    languageCode,
  };

  if (gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius: RADIUS_METERS,
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
      const plMap = mapPriceLevel(pl);

      return {
        // stable fields:
        name: p?.displayName?.text || "",
        address: p?.formattedAddress || "",
        maps_url: p?.googleMapsUri || "",
        website: p?.websiteUri || "",
        place_id: p?.id || "",
        rating: p?.rating ?? null,
        ratings_total: p?.userRatingCount ?? null,
        phone: p?.nationalPhoneNumber || "",

        // extras:
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

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  const { locale = "en", allowPlaces = false, maxResults = 4, placesRadiusMeters } = opts;

  const q = String(userQuery || "").trim();

  // --- A) KB by manifest (fast + focused) ---
  const domains = pickDomainsForQuery(q);
  const KB = getKBForDomains(domains);

  let verified_data = [];
  if (q.length >= 2 && KB.length > 0) {
    const limit = Math.max(1, Math.min(Number(maxResults || 4), 10));

    const scored = KB
      .map((r) => ({ r, score: scoreMatch(q, recordToText(r)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    verified_data = uniqBy(
      scored.map(({ r, score }) => ({
        title: r.title || r.problem || "Verified item",
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

  // --- B) Places only if allowed and intent is clear ---
  let verified_workshops = [];
  if (allowPlaces && looksLikePlacesIntent(q)) {
    verified_workshops = await searchPlaces({
      query: q,
      userLocation,
      locale,
      radiusMeters: placesRadiusMeters,
    });
  }

  return { verified_data, verified_workshops };
}
