// search.js — Local verified search + Google Places API (New) + GPS/Locale support
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// -----------------------------
// Load local KB JSON once
// -----------------------------
let KB = [];
try {
  if (fs.existsSync(DATA_DIR)) {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const p = path.join(DATA_DIR, f);
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        KB.push(...parsed.map((x) => ({ ...x, __source: f })));
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.items)) KB.push(...parsed.items.map((x) => ({ ...x, __source: f })));
        else KB.push({ ...parsed, __source: f });
      }
    }
  }
} catch (e) {
  console.error("KB load error:", e?.message || e);
  KB = [];
}

function toText(record) {
  const fields = [
    record.title,
    record.name,
    record.symptom,
    record.symptoms,
    record.problem,
    record.description,
    record.causes,
    record.checks,
    record.steps,
    record.tags,
  ];

  let s = "";
  for (const v of fields) {
    if (!v) continue;
    if (Array.isArray(v)) s += " " + v.join(" ");
    else if (typeof v === "object") s += " " + JSON.stringify(v);
    else s += " " + String(v);
  }

  if (!s.trim()) s = JSON.stringify(record);
  return s.toLowerCase();
}

// ✅ UPDATED: Unicode-safe tokenization (supports all languages, not only a-z/0-9/ar)
function scoreMatch(query, text) {
  const q = String(query || "")
    .toLowerCase()
    // keep letters/numbers across languages + spaces
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  let score = 0;
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (text.includes(t)) score += 2;
    if (t.length >= 4 && text.includes(" " + t + " ")) score += 1;
  }
  return score;
}

// -----------------------------
// Places Intent: only if explicitly asked
// -----------------------------
function detectPlacesIntent(userQuery = "") {
  const q = String(userQuery || "").toLowerCase();

  const stopSignals = ["اسكت", "لا تكتب", "stop", "be quiet", "don't answer", "do not answer", "silence"];
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

  return intentKeywords.some((w) => q.includes(w));
}

// -----------------------------
// Mode detection (tire/brake/transmission/etc)
// -----------------------------
function detectModeFromText(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("كفر") || t.includes("إطار") || t.includes("اطار") || t.includes("tire")) return "tire";
  if (t.includes("فرامل") || t.includes("brake")) return "brake";
  if (t.includes("قير") || t.includes("جير") || t.includes("ناقل") || t.includes("transmission")) return "transmission";
  return "auto_repair";
}

function buildQueryForMode(mode) {
  if (mode === "tire") return "tire shop";
  if (mode === "brake") return "brake repair";
  if (mode === "transmission") return "transmission shop";
  return "auto repair shop";
}

// -----------------------------
// Location parsing helpers
// -----------------------------
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

// ✅ Extract location from the user query itself (works when GPS is off)
function extractLocationFromQuery(userQuery = "") {
  const q = String(userQuery || "").trim();
  if (!q) return "";

  // English pattern: "in Louisville, KY" / "in Paris" etc.
  const m1 = q.match(/\bin\s+([A-Za-z][A-Za-z\s\.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i);
  if (m1 && (m1[1] || m1[2])) {
    const city = (m1[1] || "").trim();
    const region = (m1[2] || "").trim();
    const out = [city, region].filter(Boolean).join(", ");
    if (out.length >= 3) return out;
  }

  // Arabic: "في لوفل كنتاكي" / "بالرياض" / "في بغداد"
  const m2 = q.match(/(?:\bفي\b|\bبال\b|\bبـ)(\s*[^\d]{3,40})/);
  if (m2 && m2[1]) {
    const cand = m2[1].replace(/[^\u0600-\u06FFa-zA-Z,\s\.\-]/g, " ").trim();
    if (cand.length >= 3) return cand;
  }

  return "";
}

// -----------------------------
// Google Places API (New)
// -----------------------------
async function placesSearchText({ textQuery, languageCode = "en", maxResults = 5, locationBias = null }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const url = "https://places.googleapis.com/v1/places:searchText";

  const body = { textQuery, maxResultCount: maxResults, languageCode };

  if (locationBias?.lat != null && locationBias?.lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: Number(locationBias.radiusMeters || 25000),
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
  ].join(",");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6500);

  try {
    const res = await fetch(url, {
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

    return places.slice(0, maxResults).map((p) => ({
      name: p?.displayName?.text || "Workshop",
      address: p?.formattedAddress || "",
      rating: p?.rating ?? null,
      ratings_total: p?.userRatingCount ?? null, // ✅ unified name
      phone: p?.nationalPhoneNumber || "",
      website: p?.websiteUri || "",
      maps_url: p?.googleMapsUri || "",
      place_id: p?.id || "",
      lat: p?.location?.latitude ?? null,
      lng: p?.location?.longitude ?? null,
      source: "google_places_new",
    }));
  } catch (e) {
    console.error("Google Places (New) error:", e?.message || e);
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function googlePlacesWorkshops(userQuery, userLocation, locale, maxResults = 5, placesRadiusMeters = 25000) {
  const languageCode = normalizeLocale(locale);
  const gps = parseLatLng(userLocation);

  const mode = detectModeFromText(userQuery);
  const q = buildQueryForMode(mode);

  // ✅ If GPS available -> bias circle
  if (gps) {
    return await placesSearchText({
      textQuery: q,
      languageCode,
      maxResults,
      locationBias: { lat: gps.lat, lng: gps.lng, radiusMeters: placesRadiusMeters },
    });
  }

  // ✅ If no GPS -> try userLocation text, else extract from query
  let locText = safeCityText(userLocation);

  // If app sent Global/empty, pull location from query like "in Louisville, KY" or "في لوفل كنتاكي"
  if (!locText || locText.toLowerCase() === "global") {
    locText = extractLocationFromQuery(userQuery);
  }

  if (!locText) return [];

  return await placesSearchText({
    textQuery: `${q} in ${locText}`,
    languageCode,
    maxResults,
    locationBias: null,
  });
}

// -----------------------------
// Main exported search
// -----------------------------
export async function performSearch(userQuery, userLocation, opts = {}) {
  const { maxResults = 3, locale = "en", placesRadiusMeters = 25000, allowPlaces = null } = opts;

  // 1) Local KB search (CHEAP)
  let verified_data = [];
  if (userQuery && userQuery.trim().length >= 2) {
    const scored = KB
      .map((r) => {
        const t = toText(r);
        const s = scoreMatch(userQuery, t);
        return { r, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, maxResults);

    verified_data = scored.map(({ r, s }) => {
      const title = r.title || r.name || r.problem || "Verified item";
      const causes = r.causes || r.cause || "";
      const steps = r.steps || r.action_steps || r.actions || "";
      const tags = r.tags || r.category || "";
      return { title: String(title), score: s, source: r.__source || "data", causes, steps, tags };
    });
  }

  // 2) Places workshops ONLY when explicitly asked (EXPENSIVE)
  let verified_workshops = [];
  const wantsPlaces = typeof allowPlaces === "boolean" ? allowPlaces : detectPlacesIntent(userQuery);

  if (!wantsPlaces) return { verified_data, verified_workshops: [] };

  try {
    const placesMax = Number(process.env.PLACES_MAX_RESULTS || 5);
    verified_workshops = await googlePlacesWorkshops(userQuery, userLocation, locale, placesMax, placesRadiusMeters);
  } catch (e) {
    console.error("Workshops search error:", e?.message || e);
    verified_workshops = [];
  }

  return { verified_data, verified_workshops };
}
