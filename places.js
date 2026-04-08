// places.js — FixLens Global Places Legacy Fallback v2.0
// Uses Google Places Text Search API (Legacy endpoint) as compatibility / fallback.
// Prefer search.js (New Places API) first when possible.
// This file remains useful for fallback, resiliency, and simpler local search routing.

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

function normalizeSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\s\-\.\,]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(text = "", terms = []) {
  const t = normalizeText(text);
  return (Array.isArray(terms) ? terms : []).some((term) =>
    t.includes(normalizeText(term))
  );
}

function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object" && !Array.isArray(input)) {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude ?? input.lon);
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

function isZipOnly(text = "") {
  const t = String(text || "").trim();
  return /^\d{5}(-\d{4})?$/.test(t);
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(Number(n || 0), max));
}

function extractFaultCodes(text = "") {
  const matches =
    String(text || "").match(/\b([PCUB][0-9]{3,4}|[A-Z][0-9]{4})\b/gi) || [];
  return [...new Set(matches.map((x) => x.toUpperCase()))].slice(0, 10);
}

// Extract location from user text if GPS is off
function extractLocationFromText(userText = "") {
  const q = String(userText || "").trim();
  if (!q) return "";

  if (isZipOnly(q)) return q;

  const gps = parseLatLng(q);
  if (gps) return `${gps.lat},${gps.lng}`;

  // English
  const m1 = q.match(
    /\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z\s.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i
  );
  if (m1 && (m1[1] || m1[2])) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // Arabic / non-latin-friendly broad fallback
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ\b|\bب)(\s*[\p{L},\s.\-]{3,80})/u);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\p{L},\s.\-]/gu, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

function detectScript(value = "") {
  const text = String(value || "");

  if (/[\u0600-\u06FF]/.test(text)) return "arabic";
  if (/[\u0400-\u04FF]/.test(text)) return "cyrillic";
  if (/[\u4E00-\u9FFF]/.test(text)) return "han";
  if (/[\u3040-\u30FF]/.test(text)) return "japanese";
  if (/[\uAC00-\uD7AF]/.test(text)) return "hangul";
  if (/[\u0900-\u097F]/.test(text)) return "devanagari";
  if (/[A-Za-z]/.test(text)) return "latin";

  return "unknown";
}

function detectModeFromText(text = "") {
  const t = normalizeText(text);
  const codes = extractFaultCodes(text);

  if (
    hasAny(t, [
      "tire", "tyre", "اطار", "إطار", "اطارات", "إطارات", "بنشر", "ترصيص", "wheel"
    ])
  ) {
    return "tire";
  }

  if (
    hasAny(t, [
      "brake", "abs", "traction", "stability", "فرامل", "مانع الانغلاق", "ثبات", "هوبات", "سفايف"
    ]) ||
    codes.some((c) => c.startsWith("C12") || c.startsWith("C13"))
  ) {
    return "brake_abs";
  }

  if (
    hasAny(t, [
      "transmission", "gearbox", "gear", "قير", "جير", "ناقل"
    ])
  ) {
    return "transmission";
  }

  if (
    hasAny(t, [
      "battery", "starter", "alternator", "electrical", "voltage",
      "بطارية", "دينمو", "كهرباء", "شحن"
    ]) ||
    codes.some((c) => c.startsWith("U0") || c.startsWith("U1"))
  ) {
    return "electrical";
  }

  if (
    hasAny(t, [
      "overheat", "overheating", "coolant", "radiator", "temperature",
      "حرارة", "سخونة", "ماء الرديتر", "رديتر"
    ])
  ) {
    return "cooling";
  }

  if (
    hasAny(t, [
      "body shop", "collision", "paint", "dent",
      "سمكري", "حدادة سيارات", "صبغ", "دهان"
    ])
  ) {
    return "body_shop";
  }

  if (
    hasAny(t, [
      "auto parts", "car parts", "parts store", "tool store", "hardware store",
      "autozone", "o'reilly", "oreilly", "advance auto", "napa",
      "قطع غيار", "محل قطع", "محل قطع غيار", "محل أدوات", "ادوات", "أدوات"
    ])
  ) {
    return "parts_tools";
  }

  if (
    hasAny(t, [
      "tow", "towing", "tow truck", "roadside", "سطحة", "سحب", "ونش"
    ])
  ) {
    return "towing";
  }

  if (
    hasAny(t, [
      "pre purchase", "pre-purchase", "used car inspection", "inspection before buying",
      "فحص قبل الشراء", "قبل لا اشتري", "اشتريها", "تنصحني اشتري"
    ])
  ) {
    return "prepurchase";
  }

  if (
    hasAny(t, [
      "engine", "misfire", "knock", "noise", "diagnostic", "diagnostics",
      "محرك", "تقطيع", "خبط", "صوت", "تشخيص"
    ])
  ) {
    return "engine_diagnostics";
  }

  return "auto_repair";
}

function buildQueryForMode(mode = "auto_repair") {
  if (mode === "tire") return "tire shop";
  if (mode === "brake_abs") return "ABS brake specialist OR brake repair";
  if (mode === "transmission") return "transmission specialist";
  if (mode === "electrical") return "battery alternator starter electrical specialist";
  if (mode === "cooling") return "radiator coolant repair shop";
  if (mode === "body_shop") return "auto body shop OR collision repair";
  if (mode === "parts_tools") return "auto parts store OR tool store OR hardware store";
  if (mode === "towing") return "tow truck OR towing service";
  if (mode === "prepurchase") return "pre purchase inspection OR used car inspection";
  if (mode === "engine_diagnostics") return "engine diagnostics specialist OR auto repair shop";
  return "auto repair shop";
}

function mapPriceLevelTextFromLegacy(place = {}) {
  // Legacy endpoint usually doesn't provide normalized price tiers consistently.
  // Keep fields stable for downstream consumers.
  return {
    price_level: "",
    price_label: "",
    price_meaning_ar: "",
    price_meaning_en: "",
    price_hint: "",
  };
}

function inferLocalSearchMeta({ userText = "", mode = "auto_repair" }) {
  const t = normalizeText(userText);

  return {
    mode,
    script: detectScript(userText),
    detected_fault_codes: extractFaultCodes(userText),
    needs_specialist:
      mode !== "auto_repair" && mode !== "parts_tools" && mode !== "towing",
    purchase_case: hasAny(t, [
      "should i buy", "worth buying", "pre purchase", "اشتريها", "تنصحني اشتري"
    ]),
    safety_case: hasAny(t, [
      "safe to drive", "can i drive", "هل امشي بيها", "آمنة", "خطر"
    ]),
  };
}

// -----------------------------
// Legacy Places cache
// -----------------------------
const PLACES_LEGACY_CACHE = new Map();

const LEGACY_ENABLED =
  String(process.env.PLACES_LEGACY_ENABLED || "true").toLowerCase() !== "false";
const LEGACY_CACHE_TTL_MS = Number(
  process.env.PLACES_LEGACY_CACHE_TTL_MS || 10 * 60 * 1000
);
const LEGACY_TIMEOUT_MS = Number(
  process.env.PLACES_LEGACY_TIMEOUT_MS || 6500
);
const LEGACY_RADIUS_CAP = Number(
  process.env.PLACES_LEGACY_RADIUS_CAP || 50000
);

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
  PLACES_LEGACY_CACHE.set(key, {
    value,
    expiresAt: Date.now() + (ttlMs || LEGACY_CACHE_TTL_MS),
  });
}

function makeLegacyKey({ query, lang, gps, radius }) {
  const g = gps
    ? `${Number(gps.lat).toFixed(3)},${Number(gps.lng).toFixed(3)}`
    : "no_gps";
  return `${lang}::${query}::${g}::${Number(radius || 0)}`;
}

function buildMapsUrl({ name = "", placeId = "", lat = null, lng = null }) {
  if (placeId) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      name || "auto repair"
    )}&query_place_id=${encodeURIComponent(placeId)}`;
  }

  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${lat},${lng}`
    )}`;
  }

  if (name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      name
    )}`;
  }

  return "";
}

function normalizeUserLocationText(userLocation) {
  if (!userLocation) return "";

  if (typeof userLocation === "string") {
    const value = normalizeSpace(userLocation);
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

    return normalizeSpace([city, region, country].filter(Boolean).join(", "));
  }

  return "";
}

// ✅ Only call this when local-help / workshops / nearby places are actually needed.
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

  // City / ZIP / text fallback if GPS off
  let cityText = "";
  if (!gps) {
    cityText = normalizeUserLocationText(userLocation);
    if (!cityText || cityText.toLowerCase() === "global") {
      cityText = extractLocationFromText(userText);
    }
  }

  const query = cityText ? `${baseQuery} in ${cityText}` : baseQuery;

  const safeMax = clamp(maxResults || 5, 1, 10);
  const safeRadius = clamp(placesRadiusMeters || 25000, 1000, LEGACY_RADIUS_CAP);

  const cacheKey = makeLegacyKey({
    query,
    lang,
    gps,
    radius: gps ? safeRadius : 0,
  });

  const cached = legacyCacheGet(cacheKey);
  if (cached) return cached;

  let url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&language=${encodeURIComponent(lang)}` +
    `&key=${encodeURIComponent(key)}`;

  if (gps) {
    url += `&location=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
    url += `&radius=${encodeURIComponent(String(safeRadius))}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEGACY_TIMEOUT_MS);

  try {
    const f = await ensureFetch();
    const res = await f(url, { method: "GET", signal: controller.signal });
    const data = await res.json().catch(() => ({}));

    console.log("[places-legacy] query:", query);
    console.log("[places-legacy] gps:", gps ? `${gps.lat},${gps.lng}` : "none");
    console.log("[places-legacy] status:", data?.status, data?.error_message || "");

    if (!data || !Array.isArray(data.results)) return [];

    if (data.status !== "OK") {
      return [];
    }

    const localMeta = inferLocalSearchMeta({
      userText,
      mode,
    });

    const results = data.results.slice(0, safeMax);

    const mapped = results
      .map((r) => {
        const lat = r?.geometry?.location?.lat ?? null;
        const lng = r?.geometry?.location?.lng ?? null;
        const basePrice = mapPriceLevelTextFromLegacy(r);

        return {
          name: r?.name || "Workshop",
          address: r?.formatted_address || r?.vicinity || "",
          rating: safeNum(r?.rating, null),
          ratings_total: safeNum(r?.user_ratings_total, null),
          place_id: r?.place_id || "",
          maps_url: buildMapsUrl({
            name: r?.name || "auto repair",
            placeId: r?.place_id || "",
            lat,
            lng,
          }),
          lat,
          lng,
          phone: "",
          website: "",
          business_status: r?.business_status || "",
          open_now:
            typeof r?.opening_hours?.open_now === "boolean"
              ? r.opening_hours.open_now
              : null,
          primary_type:
            Array.isArray(r?.types) && r.types.length > 0
              ? String(r.types[0] || "")
              : "",
          mode,
          location_anchor: gps ? "gps" : String(cityText || ""),
          source: "google_places_legacy",
          ...basePrice,
          local_search_meta: localMeta,
        };
      })
      .filter((x) => x.name && (x.address || x.maps_url || x.place_id));

    const deduped = uniqBy(
      mapped,
      (x) => x.place_id || x.maps_url || `${x.name}::${x.address}`
    );

    legacyCacheSet(cacheKey, deduped, LEGACY_CACHE_TTL_MS);
    return deduped;
  } catch (e) {
    console.error("[places-legacy] fetch error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
