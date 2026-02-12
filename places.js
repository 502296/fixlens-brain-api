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

function buildQuery(userLocation, mode = "auto_repair") {
  const loc = String(userLocation || "").trim();
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
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  // If GPS object passed, legacy endpoint can still work but without perfect bias.
  // We'll fall back to text, or just use "lat,lng" as hint.
  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(userText);
  const locationText =
    typeof userLocation === "string"
      ? userLocation
      : gps
      ? `${gps.lat},${gps.lng}`
      : "United States";

  const query = buildQuery(locationText, mode);

  const url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&language=${encodeURIComponent(normalizeLocale(locale))}` +
    `&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();

    if (!data || data.status !== "OK" || !Array.isArray(data.results)) {
      console.error("Places status:", data?.status, data?.error_message || "");
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
