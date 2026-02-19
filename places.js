// places.js — Google Places Text Search (Legacy endpoint)
// Uses Places Text Search API (Legacy endpoint). Requires billing enabled.
// NOTE: Prefer the "New Places API" in search.js when possible.
// This legacy file remains as fallback / compatibility.

let _fetch = globalThis.fetch;
async function ensureFetch() {
  if (_fetch) return _fetch;
  const mod = await import("node-fetch");
  _fetch = mod.default;
  return _fetch;
}

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function normalizeLocale(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

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

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isZipOnly(text = "") {
  const t = String(text || "").trim();
  return /^\d{5}(-\d{4})?$/.test(t);
}

// Extract location from user text if GPS off (simple but helpful)
function extractLocationFromText(userText = "") {
  const q = String(userText || "").trim();
  if (!q) return "";

  if (isZipOnly(q)) return q;

  // English: "in Louisville, KY"
  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s\.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1 && (m1[1] || m1[2])) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // Arabic: "في لوفل كنتاكي" / "بالرياض"
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ)(\s*[^\d]{3,60})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s\.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
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

// Build a query WITHOUT "in lat,lng" when GPS exists
function buildQueryForMode(mode = "auto_repair") {
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake repair";
  if (mode === "transmission") return "transmission shop";
  if (mode === "electrical") return "battery alternator starter shop";
  if (mode === "cooling") return "radiator coolant repair shop";
  return "auto repair shop";
}

function detectModeFromText(text) {
  const t = (text || "").toLowerCase();

  // Arabic hints
  if (t.includes("كفر") || t.includes("إطار") || t.includes("اطار") || t.includes("tire") || t.includes("tyre")) return "tire";
  if (t.includes("فرامل") || t.includes("brake")) return "brake";
  if (t.includes("قير") || t.includes("جير") || t.includes("ناقل") || t.includes("transmission")) return "transmission";
  if (t.includes("بطارية") || t.includes("battery") || t.includes("starter") || t.includes("alternator")) return "electrical";
  if (t.includes("حرارة") || t.includes("overheat") || t.includes("coolant") || t.includes("radiator")) return "cooling";

  return "auto_repair";
}

// -----------------------------
// Legacy Places cache (cost control)
// -----------------------------
const PLACES_LEGACY_CACHE = new Map();

const LEGACY_ENABLED = String(process.env.PLACES_LEGACY_ENABLED || "true").toLowerCase() !== "false";
const LEGACY_CACHE_TTL_MS = Number(process.env.PLACES_LEGACY_CACHE_TTL_MS || 10 * 60 * 1000); // 10 min
const LEGACY_TIMEOUT_MS = Number(process.env.PLACES_LEGACY_TIMEOUT_MS || 6500);
const LEGACY_RADIUS_CAP = Number(process.env.PLACES_LEGACY_RADIUS_CAP || 50000);

function legacyCacheGet(key) {
  const hit = PLACES_LEGACY_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    PLACES_LEGACY_CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function legacyCacheSet(key, value, ttlMs) {
  PLACES_LEGACY_CACHE.set(key, { value, expiresAt: Date.now() + (ttlMs || LEGACY_CACHE_TTL_MS) });
}

function makeLegacyKey({ query, lang, gps, radius }) {
  const g = gps ? `${Number(gps.lat).toFixed(3)},${Number(gps.lng).toFixed(3)}` : "no_gps";
  return `${lang}::${query}::${g}::${Number(radius || 0)}`;
}

// ✅ Only call this when user explicitly asks for workshops/nearby places.
export async function searchPlacesWorkshops({
  userLocation,
  userText,
  maxResults = 5,
  locale = "en",
  placesRadiusMeters = 25000,
}) {
  if (!LEGACY_ENABLED) return [];

  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    console.error("[places-legacy] Missing GOOGLE_PLACES_API_KEY");
    return [];
  }

  const lang = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(userText);
  const baseQuery = buildQueryForMode(mode);

  // City fallback if GPS off
  let cityText = "";
  if (!gps) {
    if (typeof userLocation === "string") cityText = normalizeSpace(userLocation);
    if (!cityText || cityText.toLowerCase() === "global") {
      cityText = extractLocationFromText(userText);
    }
  }

  const query = cityText ? `${baseQuery} in ${cityText}` : baseQuery;

  const safeMax = Math.max(1, Math.min(Number(maxResults || 5), 10));
  const safeRadius = Math.max(1000, Math.min(Number(placesRadiusMeters || 25000), LEGACY_RADIUS_CAP));

  const cacheKey = makeLegacyKey({ query, lang, gps, radius: gps ? safeRadius : 0 });
  const cached = legacyCacheGet(cacheKey);
  if (cached) return cached;

  let url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&language=${encodeURIComponent(lang)}` +
    `&key=${encodeURIComponent(key)}`;

  // Bias results with location + radius when GPS exists
  if (gps) {
    url += `&location=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
    url += `&radius=${encodeURIComponent(String(safeRadius))}`;
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), LEGACY_TIMEOUT_MS);

  try {
    const f = await ensureFetch();
    const res = await f(url, { method: "GET", signal: controller.signal });
    const data = await res.json().catch(() => ({}));

    // Minimal logs (Render)
    console.log("[places-legacy] query:", query);
    console.log("[places-legacy] gps:", gps ? `${gps.lat},${gps.lng}` : "none");
    console.log("[places-legacy] status:", data?.status, data?.error_message || "");

    if (!data || !Array.isArray(data.results)) return [];

    if (data.status !== "OK") {
      // ZERO_RESULTS is valid; return []
      return [];
    }

    const results = data.results.slice(0, safeMax);

    const mapped = results
      .map((r) => ({
        name: r?.name || "Workshop",
        address: r?.formatted_address || r?.vicinity || "",
        rating: safeNum(r?.rating, null),
        ratings_total: safeNum(r?.user_ratings_total, null),
        place_id: r?.place_id || "",
        maps_url: r?.place_id
          ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(r?.name || "auto repair")}&query_place_id=${encodeURIComponent(r.place_id)}`
          : "",
        lat: r?.geometry?.location?.lat ?? null,
        lng: r?.geometry?.location?.lng ?? null,
        source: "google_places_legacy",
      }))
      // Filter out ultra-empty entries
      .filter((x) => x.name && (x.address || x.maps_url || x.place_id));

    const deduped = uniqBy(mapped, (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`);

    legacyCacheSet(cacheKey, deduped, LEGACY_CACHE_TTL_MS);
    return deduped;
  } catch (e) {
    console.error("[places-legacy] fetch error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(t);
  }
}
