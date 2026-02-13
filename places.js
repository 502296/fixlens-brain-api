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

// ✅ Better: build a query WITHOUT "in lat,lng" when GPS exists
function buildQueryForMode(mode = "auto_repair") {
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake repair";
  if (mode === "transmission") return "transmission shop";
  return "auto repair shop";
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
  placesRadiusMeters = 25000,
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    console.error("[places] Missing GOOGLE_PLACES_API_KEY");
    return [];
  }

  const lang = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(userText);
  const baseQuery = buildQueryForMode(mode);

  // ✅ If location is a city string, we can use "in city"
  const cityText = typeof userLocation === "string" ? String(userLocation).trim() : "";
  const hasCity = cityText && !gps; // if gps exists, prefer gps bias

  const query = hasCity ? `${baseQuery} in ${cityText}` : baseQuery;

  let url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&language=${encodeURIComponent(lang)}` +
    `&key=${encodeURIComponent(key)}`;

  // ✅ CRITICAL: if GPS exists, bias results using location + radius
  if (gps) {
    const radius = Math.max(1000, Math.min(50000, Number(placesRadiusMeters) || 25000));
    url += `&location=${encodeURIComponent(`${gps.lat},${gps.lng}`)}`;
    url += `&radius=${encodeURIComponent(String(radius))}`;
  }

  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();

    // ✅ Add helpful logs (you’ll see these in Render Logs)
    console.log("[places] query:", query);
    console.log("[places] gps:", gps ? `${gps.lat},${gps.lng}` : "none");
    console.log("[places] status:", data?.status, data?.error_message || "");

    if (!data || !Array.isArray(data.results)) {
      return [];
    }

    if (data.status !== "OK") {
      // ZERO_RESULTS is a valid case; return []
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
    console.error("[places] fetch error:", e?.message || e);
    return [];
  }
}
