// search.js — Local verified search + Google Places API (New) + GPS/Locale support
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// -----------------------------
// Node fetch safety (works on Node 18+ and older)
// -----------------------------
let _fetch = globalThis.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
  // node-fetch v3 is ESM; dynamic import is safe
  const mod = await import("node-fetch");
  _fetch = mod.default;
  return _fetch;
}

// -----------------------------
// Load local KB JSON once (CHEAP) + safe normalization
// -----------------------------
let KB = [];
let KB_LOADED = false;

function loadKBOnce() {
  if (KB_LOADED) return;
  KB_LOADED = true;

  try {
    if (!fs.existsSync(DATA_DIR)) {
      KB = [];
      return;
    }

    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
    const attachSource = (f) => (x) => ({ ...x, __source: f });

    for (const f of files) {
      const p = path.join(DATA_DIR, f);
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);

      const tag = attachSource(f);

      if (Array.isArray(parsed)) {
        KB.push(...parsed.map(tag));
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.items)) KB.push(...parsed.items.map(tag));
        else KB.push(tag(parsed));
      }
    }
  } catch (e) {
    console.error("KB load error:", e?.message || e);
    KB = [];
  }
}

// -----------------------------
// Small helpers (Unicode safe)
// -----------------------------
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

function normalizeSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocale(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

function normalizeForSearch(s) {
  // Keep letters/numbers across languages + spaces
  return normalizeSpace(
    String(s || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
  );
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// -----------------------------
// KB -> searchable text
// (field boosts will be applied in scoring)
// -----------------------------
function toText(record) {
  const fields = [
    record.title,
    record.name,
    record.problem,
    record.symptom,
    record.symptoms,
    record.symptom_short,
    record.symptom_patterns,
    record.description,
    record.likely_causes,
    record.recommended_checks,
    record.safety_warning,
    record.causes,
    record.checks,
    record.steps,
    record.tags,
    record.category,
    record.system,
  ];

  let s = "";
  for (const v of fields) {
    const chunk = safeStr(v);
    if (!chunk) continue;
    s += " " + chunk;
  }

  if (!s.trim()) s = safeStr(record);
  return normalizeForSearch(s);
}

// -----------------------------
// Smarter scoring (Enterprise-ish)
// - Unicode tokenization
// - phrase bonus
// - field-aware boosts (when present)
// -----------------------------
function tokenize(query) {
  const q = normalizeForSearch(query);
  const tokens = q.split(" ").filter(Boolean);
  // remove extremely short tokens + cap to avoid heavy loops
  return tokens.filter((t) => t.length >= 2).slice(0, 24);
}

function containsWord(text, token) {
  // simple boundary-ish: spaces around; still ok cross-lang
  return (
    text.includes(" " + token + " ") ||
    text.startsWith(token + " ") ||
    text.endsWith(" " + token) ||
    text === token
  );
}

function scoreMatch(query, recordText, recordObj) {
  const qNorm = normalizeForSearch(query);
  const text = " " + String(recordText || "") + " ";
  const tokens = tokenize(qNorm);
  if (tokens.length === 0) return 0;

  let score = 0;

  // Phrase bonus for longer queries (helps exact symptom phrases)
  if (qNorm.length >= 10 && text.includes(" " + qNorm + " ")) score += 12;

  // Token scoring
  for (const t of tokens) {
    if (text.includes(t)) score += 2;

    if (t.length >= 4 && containsWord(text, t)) score += 2;

    // Diagnostic codes: P0300 etc.
    if (/^p0\d{3}$/i.test(t)) {
      if (text.includes(t.toLowerCase())) score += 10;
    }
  }

  // Field boosts (cheap but effective)
  const title = normalizeForSearch(recordObj?.title || recordObj?.name || "");
  const category = normalizeForSearch(recordObj?.category || "");
  const system = normalizeForSearch(recordObj?.system || "");
  const symptom = normalizeForSearch(recordObj?.symptom_short || recordObj?.symptom || "");
  const tags = normalizeForSearch(safeStr(recordObj?.tags || ""));

  for (const t of tokens) {
    if (t.length < 3) continue;
    if (title && title.includes(t)) score += 4;
    if (symptom && symptom.includes(t)) score += 3;
    if (category && category.includes(t)) score += 2;
    if (system && system.includes(t)) score += 2;
    if (tags && tags.includes(t)) score += 1;
  }

  return score;
}

// -----------------------------
// Places Intent: only if explicitly asked
// -----------------------------
function detectPlacesIntent(userQuery = "") {
  const q = String(userQuery || "").toLowerCase().trim();
  if (!q) return false;

  const stopSignals = [
    "اسكت",
    "لا تكتب",
    "stop",
    "be quiet",
    "don't answer",
    "do not answer",
    "silence",
  ];
  if (stopSignals.some((w) => q.includes(w))) return false;

  const intentKeywords = [
    // English
    "workshop",
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "car shop",
    "near me",
    "closest",
    "nearby",
    "address",
    "google maps",
    "where can i fix",
    "where to fix",
    "tire shop",
    "tyre shop",
    "alignment",
    "oil change",

    // Arabic
    "ورشة",
    "كراج",
    "ميكانيك",
    "ميكانيكي",
    "محل تصليح",
    "محل ميكانيك",
    "محل اطارات",
    "إطارات",
    "اطارات",
    "تواير",
    "ميزان",
    "ترصيص",
    "قريب مني",
    "اقرب",
    "عنوان",
    "خرائط",
    "وين اصلح",
    "وين اروح",

    // Others (light)
    "taller",
    "mecanico",
    "mécanicien",
    "werkstatt",
    "автосервис",
    "рядом",
    "附近",
    "近く",
    "근처",
  ];

  const hasIntent = intentKeywords.some((w) => q.includes(w));
  const hasZip = /\b\d{5}(-\d{4})?\b/.test(q);

  // إذا كتب zip ومعه نية بحث (محل/ورشة/near) نخليه true
  if (hasZip && (hasIntent || q.includes("near") || q.includes("قريب") || q.includes("اقرب"))) {
    return true;
  }

  return hasIntent;
}

// -----------------------------
// Mode detection (tire/brake/transmission/etc)
// -----------------------------
function detectModeFromText(text) {
  const t = (text || "").toLowerCase();

  if (
    t.includes("كفر") ||
    t.includes("إطار") ||
    t.includes("اطار") ||
    t.includes("اطارات") ||
    t.includes("إطارات") ||
    t.includes("تواير") ||
    t.includes("tire") ||
    t.includes("tyre") ||
    t.includes("alignment") ||
    t.includes("balancing") ||
    t.includes("rotation")
  )
    return "tire";

  if (t.includes("فرامل") || t.includes("brake")) return "brake";
  if (t.includes("قير") || t.includes("جير") || t.includes("ناقل") || t.includes("transmission"))
    return "transmission";
  if (t.includes("بطارية") || t.includes("battery") || t.includes("starter") || t.includes("alternator"))
    return "electrical";
  if (t.includes("حرارة") || t.includes("overheat") || t.includes("coolant") || t.includes("radiator"))
    return "cooling";

  return "auto_repair";
}

function buildQueryForMode(mode) {
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake repair";
  if (mode === "transmission") return "transmission shop";
  if (mode === "electrical") return "battery alternator starter shop";
  if (mode === "cooling") return "radiator coolant repair shop";
  return "auto repair shop";
}

// -----------------------------
// Location parsing helpers
// -----------------------------
function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    return null;
  }

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

function safeCityText(userLocation) {
  if (!userLocation) return "";
  if (typeof userLocation === "string") return userLocation.trim();

  if (typeof userLocation === "object") {
    const city = userLocation.city || userLocation.locality || "";
    const region = userLocation.region || userLocation.state || "";
    const country = userLocation.country || "";
    const combo = [city, region, country].filter(Boolean).join(", ");
    return combo.trim();
  }
  return "";
}

// ZIP-only (US-style): 40218 or 40218-1234
function isZipOnly(text = "") {
  const t = String(text || "").trim();
  return /^\d{5}(-\d{4})?$/.test(t);
}

// Extract location from user query (works when GPS is off)
function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  // direct ZIP anywhere in the sentence
  const zipMatch = q.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (zipMatch?.[1]) return zipMatch[1];

  // English: "in Louisville, KY" / "in Paris"
  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s\.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1 && (m1[1] || m1[2])) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // Arabic: "في لوفل كنتاكي" / "بالرياض" / "في بغداد"
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ)(\s*[^\d]{3,60})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s\.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

// -----------------------------
// Google Places API (New) — EXPENSIVE
// + Cache to reduce cost
// -----------------------------
const PLACES_CACHE = new Map();
const GEOCODE_CACHE = new Map();

// Defaults
const PLACES_CACHE_TTL_MS = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const GEOCODE_CACHE_TTL_MS = Number(process.env.GEOCODE_CACHE_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const PLACES_TIMEOUT_MS = Number(process.env.PLACES_TIMEOUT_MS || 6500);
const GEOCODE_TIMEOUT_MS = Number(process.env.GEOCODE_TIMEOUT_MS || 5000);
const PLACES_MAX_RESULTS_DEFAULT = Number(process.env.PLACES_MAX_RESULTS || 5);
const PLACES_RADIUS_CAP = Number(process.env.PLACES_RADIUS_CAP || 50000); // cap radius
const PLACES_ENABLED = String(process.env.PLACES_ENABLED || "true").toLowerCase() !== "false";

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + (ttlMs || 0) });
}

function makePlacesCacheKey({ textQuery, languageCode, locationBias }) {
  const bias =
    locationBias?.lat != null && locationBias?.lng != null
      ? `${Number(locationBias.lat).toFixed(3)},${Number(locationBias.lng).toFixed(3)}:${Number(
          locationBias.radiusMeters || 0
        )}`
      : "no_bias";
  return `${languageCode}::${textQuery}::${bias}`;
}

// -----------------------------
// Geocoding (ZIP / City -> lat,lng) (Optional but very useful)
// Requires enabling Geocoding API in Google Cloud.
// -----------------------------
async function geocodeAddressToLatLng(addressText) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null;

  const addr = String(addressText || "").trim();
  if (!addr) return null;

  const cacheKey = addr.toLowerCase();
  const cached = cacheGet(GEOCODE_CACHE, cacheKey);
  if (cached) return cached;

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    addr
  )}&key=${encodeURIComponent(key)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const f = await ensureFetch();
    const res = await f(url, { method: "GET", signal: controller.signal });

    const data = await res.json().catch(() => ({}));
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    const loc = first?.geometry?.location;

    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const out = { lat, lng };
      cacheSet(GEOCODE_CACHE, cacheKey, out, GEOCODE_CACHE_TTL_MS);
      return out;
    }

    // cache negative for short time to avoid spam
    cacheSet(GEOCODE_CACHE, cacheKey, null, 15 * 60 * 1000);
    return null;
  } catch (e) {
    console.error("Geocode error:", e?.message || e);
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function placesSearchText({ textQuery, languageCode = "en", maxResults = 5, locationBias = null }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];
  if (!PLACES_ENABLED) return [];

  const safeMax = Math.max(1, Math.min(Number(maxResults || 5), 10));
  const safeRadius = Math.max(1000, Math.min(Number(locationBias?.radiusMeters || 25000), PLACES_RADIUS_CAP));

  const cacheKey = makePlacesCacheKey({
    textQuery,
    languageCode,
    locationBias: locationBias ? { ...locationBias, radiusMeters: safeRadius } : null,
  });

  const cached = cacheGet(PLACES_CACHE, cacheKey);
  if (cached) return cached;

  const url = "https://places.googleapis.com/v1/places:searchText";

  // NOTE: languageCode affects UI strings; results are still fine in most locales.
  const body = { textQuery, maxResultCount: safeMax, languageCode };

  if (locationBias?.lat != null && locationBias?.lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: safeRadius,
      },
    };
  }

  const fieldMask = [
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.rating",
    "places.userRatingCount",
    "places.googleMapsUri",
    "places.nationalPhoneNumber",
    "places.websiteUri",
    "places.id",
    "places.primaryType",
    "places.types",
  ].join(",");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);

  try {
    const f = await ensureFetch();
    const res = await f(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => ({}));
    const places = Array.isArray(data?.places) ? data.places : [];

    const mapped = places.slice(0, safeMax).map((p) => ({
      name: p?.displayName?.text || "Shop",
      address: p?.formattedAddress || "",
      rating: p?.rating ?? null,
      ratings_total: p?.userRatingCount ?? null,
      phone: p?.nationalPhoneNumber || "",
      website: p?.websiteUri || "",
      maps_url: p?.googleMapsUri || "",
      place_id: p?.id || "",
      lat: p?.location?.latitude ?? null,
      lng: p?.location?.longitude ?? null,
      types: p?.types || [],
      primaryType: p?.primaryType || "",
      source: "google_places_new",
    }));

    const deduped = uniqBy(mapped, (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`);

    cacheSet(PLACES_CACHE, cacheKey, deduped, PLACES_CACHE_TTL_MS);
    return deduped;
  } catch (e) {
    console.error("Google Places (New) error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// Places: main path
// - GPS -> bias directly
// - No GPS -> try geocode ZIP/city -> bias -> better results
// - If geocode fails -> fallback to text query with "near"
// -----------------------------
async function googlePlacesWorkshops(userQuery, userLocation, locale, maxResults = 5, placesRadiusMeters = 25000) {
  // Keep locale for strings, but if it's something odd, fallback to en
  const lc = normalizeLocale(locale);
  const languageCode = lc || "en";

  const gps = parseLatLng(userLocation);
  const mode = detectModeFromText(userQuery);
  const q = buildQueryForMode(mode);

  const requestedRadius = Number(placesRadiusMeters || 25000);

  // 1) GPS best
  if (gps) {
    return await placesSearchText({
      textQuery: q,
      languageCode,
      maxResults,
      locationBias: { lat: gps.lat, lng: gps.lng, radiusMeters: requestedRadius },
    });
  }

  // 2) Try textual location: from user_location object/string or extracted from query
  let locText = safeCityText(userLocation);
  if (!locText || locText.toLowerCase() === "global") {
    locText = extractLocationFromQuery(userQuery);
  }
  locText = String(locText || "").trim();
  if (!locText) return [];

  // 2a) Try geocode it -> bias search (BEST when GPS off)
  const geo = await geocodeAddressToLatLng(locText);
  if (geo?.lat != null && geo?.lng != null) {
    return await placesSearchText({
      textQuery: q,
      languageCode,
      maxResults,
      locationBias: { lat: geo.lat, lng: geo.lng, radiusMeters: requestedRadius },
    });
  }

  // 2b) Fallback: plain text search with "near"
  // (works even if Geocoding API is not enabled)
  const textQuery = `${q} near ${locText}`;
  return await placesSearchText({
    textQuery,
    languageCode,
    maxResults,
    locationBias: null,
  });
}

// -----------------------------
// Main exported search
// -----------------------------
export async function performSearch(userQuery, userLocation, opts = {}) {
  // Ensure KB is loaded once (and uses your /data to reduce cost)
  loadKBOnce();

  const {
    maxResults = 3,
    locale = "en",
    placesRadiusMeters = 25000,
    allowPlaces = null,
  } = opts;

  // -------------------------
  // 1) Local KB search (CHEAP)
  // -------------------------
  let verified_data = [];
  const q = String(userQuery || "").trim();

  if (q.length >= 2 && KB.length > 0) {
    const limit = Math.max(1, Math.min(Number(maxResults || 3), 10));

    const scored = KB
      .map((r) => {
        const t = toText(r);
        const s = scoreMatch(q, t, r);
        return { r, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);

    verified_data = scored.map(({ r, s }) => {
      const title = r.title || r.name || r.problem || "Verified item";

      const causes =
        r.causes ||
        r.cause ||
        r.likely_causes ||
        r.likelyCauses ||
        "";

      const checks =
        r.checks ||
        r.tests ||
        r.recommended_checks ||
        r.recommendedChecks ||
        "";

      const steps =
        r.steps ||
        r.action_steps ||
        r.actions ||
        "";

      const tags = r.tags || r.category || r.system || "";

      return {
        title: String(title),
        score: s,
        source: r.__source || "data",
        causes,
        checks,
        steps,
        tags,
      };
    });

    // Dedup by title+source
    verified_data = uniqBy(verified_data, (x) => `${String(x.title || "").toLowerCase()}::${x.source}`);
  }

  // ---------------------------------------------
  // 2) Places workshops ONLY when explicitly asked
  // ---------------------------------------------
  let verified_workshops = [];

  const wantsPlaces = typeof allowPlaces === "boolean" ? allowPlaces : detectPlacesIntent(userQuery);

  // Cost control: if Places not requested -> return local only
  if (!wantsPlaces) return { verified_data, verified_workshops: [] };

  // If no API key OR Places disabled -> return local only
  if (!process.env.GOOGLE_PLACES_API_KEY) return { verified_data, verified_workshops: [] };
  if (!PLACES_ENABLED) return { verified_data, verified_workshops: [] };

  try {
    const placesMax = Math.max(1, Math.min(PLACES_MAX_RESULTS_DEFAULT, 10));
    verified_workshops = await googlePlacesWorkshops(
      userQuery,
      userLocation,
      locale,
      placesMax,
      Number(placesRadiusMeters || 25000)
    );
  } catch (e) {
    console.error("Workshops search error:", e?.message || e);
    verified_workshops = [];
  }

  return { verified_data, verified_workshops };
}
