// places.js — Google Places Text Search (Web) (Legacy endpoint)
// Uses Places Text Search API (Legacy endpoint). Requires billing enabled.

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

// ✅ Treat "Global" (or similar) as empty location, so we don't query "in Global"
function isGlobalLike(s) {
  const v = String(s || "").trim().toLowerCase();
  return v === "global" || v === "world" || v === "worldwide" || v === "anywhere";
}

// ✅ Build query text.
// - If we have GPS, we DO NOT add "in <location>" (we use location+radius params instead)
// - If no GPS, we do "in <base>" but we never allow base="Global"
function buildQuery(userLocation, mode = "auto_repair", hasGps = false) {
  const locRaw = String(userLocation || "").trim();
  const loc = (!locRaw || isGlobalLike(locRaw)) ? "" : locRaw;

  if (hasGps) {
    if (mode === "tire") return "tire shop";
    if (mode === "brake") return "brake repair";
    if (mode === "transmission") return "transmission shop";
    return "auto repair shop";
  }

  const base = loc ? loc : "United States";

  if (mode === "tire") return `tire shop in ${base}`;
  if (mode === "brake") return `brake repair in ${base}`;
  if (mode === "transmission") return `transmission shop in ${base}`;
  return `auto repair shop in ${base}`;
}

function detectModeFromText(text) {
  const t = (text || "").toLowerCase();

  // Arabic hints
  if (t.includes("كفر") || t.includes("إطار") || t.includes("اطار") || t.includes("tire"))
    return "tire";
  if (t.includes("فرامل") || t.includes("brake")) return "brake";
  if (t.includes("قير") || t.includes("جير") || t.includes("ناقل") || t.includes("transmission"))
    return "transmission";

  return "auto_repair";
}

// ✅ Only call this when user explicitly asks for workshops/nearby places.
export async function searchPlacesWorkshops({
  userLocation,
  userText,
  maxResults = 5,
  locale = "en",
  // ✅ NEW (optional): allow radius from server request
  radiusMeters = 25000,
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(userText);

  // ✅ If location is string "Global", treat it as empty
  const locationText =
    typeof userLocation === "string"
      ? (isGlobalLike(userLocation) ? "" : userLocation)
      : gps
      ? `${gps.lat},${gps.lng}`
      : "";

  // ✅ Query rules:
  // - if GPS exists: query WITHOUT "in ..." + add location+radius params
  // - else: query WITH "in United States" (or user's typed city/country)
  const query = buildQuery(locationText, mode, Boolean(gps));

  // ✅ Clamp radius to sane range for legacy endpoint
  const radius = Math.max(1000, Math.min(safeNum(radiusMeters, 25000), 50000));

  // Base URL
  let url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&language=${encodeURIComponent(normalizeLocale(locale))}` +
    `&key=${encodeURIComponent(key)}`;

  // ✅ If GPS exists, bias results properly (THIS IS THE KEY FIX)
  if (gps) {
    url += `&location=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
    url += `&radius=${encodeURIComponent(String(radius))}`;
  }

  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();

    // ✅ Better logging so we can see the REAL reason (REQUEST_DENIED, ZERO_RESULTS, etc.)
    if (!data || !Array.isArray(data.results)) {
      console.error("Places bad response:", data);
      return [];
    }

    if (data.status !== "OK") {
      console.error("Places status:", data?.status, data?.error_message || "");
      // ✅ If ZERO_RESULTS, we just return [] (no crash)
      return [];
    }

    const results = data.results.slice(0, maxResults);

    return results.map((r) => ({
      name: r?.name || "Workshop",
      address: r?.formatted_address || r?.vicinity || "",
      rating: safeNum(r?.rating, 0),
      ratings_total: safeNum(r?.user_ratings_total, 0),
      place_id: r?.place_id || "",
      maps_url: r?.place_id
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
            r?.name || "auto repair"
          )}&query_place_id=${encodeURIComponent(r.place_id)}`
        : "",
      source: "google_places_legacy",
    }));
  } catch (e) {
    console.error("Places fetch error:", e?.message || e);
    return [];
  }
}
