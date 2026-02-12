// places.js — Google Places Text Search (Web)
// Uses Places Text Search API (Legacy endpoint). Requires billing enabled.

function safeNum(n, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function buildQuery(userLocation, mode = "auto_repair") {
  const loc = String(userLocation || "").trim();
  // If userLocation is empty, fallback to generic (but better to pass a city/state)
  const base = loc ? loc : "United States";

  // You can tweak the query phrases for better results
  if (mode === "tire") return `tire shop in ${base}`;
  if (mode === "brake") return `brake repair in ${base}`;
  if (mode === "transmission") return `transmission shop in ${base}`;
  return `auto repair shop in ${base}`;
}

function detectModeFromText(text) {
  const t = (text || "").toLowerCase();

  // Arabic hints
  if (t.includes("كفر") || t.includes("إطار") || t.includes("اطار") || t.includes("tire")) return "tire";
  if (t.includes("فرامل") || t.includes("brake")) return "brake";
  if (t.includes("قير") || t.includes("جير") || t.includes("ناقل") || t.includes("transmission")) return "transmission";

  return "auto_repair";
}

export async function searchPlacesWorkshops({
  userLocation,
  userText,
  maxResults = 5,
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const mode = detectModeFromText(userText);
  const query = buildQuery(userLocation, mode);

  const url =
    "https://maps.googleapis.com/maps/api/place/textsearch/json" +
    `?query=${encodeURIComponent(query)}` +
    `&key=${encodeURIComponent(key)}`;

  try {
    const res = await fetch(url, { method: "GET" });
    const data = await res.json();

    if (!data || data.status !== "OK" || !Array.isArray(data.results)) {
      // Possible statuses: ZERO_RESULTS, OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST
      console.error("Places status:", data?.status, data?.error_message || "");
      return [];
    }

    const results = data.results.slice(0, maxResults);

    // Normalize output
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
      source: "google_places",
    }));
  } catch (e) {
    console.error("Places fetch error:", e?.message || e);
    return [];
  }
}
