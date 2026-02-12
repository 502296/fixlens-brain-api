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
        if (Array.isArray(parsed.items))
          KB.push(...parsed.items.map((x) => ({ ...x, __source: f })));
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

function scoreMatch(query, text) {
  const q = query.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ");
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
// ✅ Places Intent (CRITICAL FIX)
// Only call Google Places when user explicitly asks for a shop/workshop.
// Works across many languages.
// -----------------------------
function detectPlacesIntent(userQuery = "") {
  const q = String(userQuery || "").toLowerCase();

  // If user explicitly asks to be quiet / stop / don't answer, treat as NO intent.
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

  // Explicit workshop / mechanic / near me intent keywords
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
    "recommend a shop",
    "recommend me a shop",
    "send me a shop",
    "find me a shop",
    "where can i fix",
    "where to fix",
    "where should i go",

    // Arabic
    "ورشة",
    "كراج",
    "ميكانيك",
    "ميكانيكي",
    "تصليح",
    "أصلح",
    "وين أصلح",
    "وين اروح",
    "قريب مني",
    "اقرب ورشة",
    "دلني على ورشة",
    "رشح ورشة",
    "محل تصليح",
    "محل ميكانيك",

    // Spanish
    "taller",
    "mecánico",
    "taller mecánico",
    "cerca de mí",

    // French
    "garage",
    "mécanicien",
    "près de moi",

    // German
    "werkstatt",
    "mechaniker",
    "in der nähe",

    // Italian
    "officina",
    "meccanico",
    "vicino a me",

    // Portuguese
    "oficina",
    "mecânico",
    "perto de mim",

    // Turkish
    "servis",
    "tamirci",
    "yakınımda",

    // Russian
    "сервис",
    "мастерская",
    "рядом",

    // Chinese
    "修车",
    "修理厂",
    "附近",

    // Japanese
    "修理工場",
    "整備工場",
    "近く",

    // Korean
    "정비소",
    "근처",

    // Hindi
    "वर्कशॉप",
    "मैकेनिक",
    "पास में",
  ];

  return intentKeywords.some((w) => q.includes(w));
}

// -----------------------------
// Location parsing helpers
// -----------------------------
function normalizeLocale(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  // Use language only for Places languageCode, e.g. ar-IQ -> ar
  return v.split("-")[0].toLowerCase() || "en";
}

function parseLatLng(input) {
  // Accept:
  // 1) { lat, lng }
  // 2) { latitude, longitude }
  // 3) "lat,lng"
  // 4) "lat lng"
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
  // If location is a plain string like "Louisville, KY"
  if (!userLocation) return "";
  if (typeof userLocation === "string") return userLocation.trim();

  // If it’s an object but without lat/lng, try to read city fields
  if (typeof userLocation === "object") {
    const city = userLocation.city || userLocation.locality || "";
    const region = userLocation.region || userLocation.state || "";
    const country = userLocation.country || "";
    const combo = [city, region, country].filter(Boolean).join(", ");
    return combo.trim();
  }
  return "";
}

// -----------------------------
// Google Places API (New)
// -----------------------------
async function placesSearchText({
  textQuery,
  languageCode = "en",
  maxResults = 5,
  locationBias = null, // { lat, lng, radiusMeters }
}) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return [];

  const url = "https://places.googleapis.com/v1/places:searchText";

  const body = {
    textQuery,
    maxResultCount: maxResults,
    languageCode,
  };

  // If we have GPS, bias results to the user's city/area
  if (locationBias?.lat != null && locationBias?.lng != null) {
    body.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: Number(locationBias.radiusMeters || 25000), // default 25km
      },
    };
  }

  // We request the fields we need only
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
      ratings_count: p?.userRatingCount ?? null,
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

async function googlePlacesWorkshops(userLocation, locale, maxResults = 5, placesRadiusMeters = 25000) {
  const languageCode = normalizeLocale(locale);

  // Prefer GPS if available
  const gps = parseLatLng(userLocation);

  // If GPS exists → bias near the user (same city/area)
  if (gps) {
    const query = "auto repair shop";
    return await placesSearchText({
      textQuery: query,
      languageCode,
      maxResults,
      locationBias: { lat: gps.lat, lng: gps.lng, radiusMeters: placesRadiusMeters },
    });
  }

  // Else use city text if provided
  const locText = safeCityText(userLocation);
  if (!locText) return [];

  const query = `auto repair shop in ${locText}`;
  return await placesSearchText({
    textQuery: query,
    languageCode,
    maxResults,
    locationBias: null,
  });
}

// -----------------------------
// Main exported search
// -----------------------------
export async function performSearch(userQuery, userLocation, opts = {}) {
  const {
    maxResults = 3,
    locale = "en",
    placesRadiusMeters = 25000,
    // ✅ allowPlaces lets server force Places on/off if needed
    allowPlaces = null, // null = auto-detect intent
  } = opts;

  // 1) Local KB search
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
      return {
        title: String(title),
        score: s,
        source: r.__source || "data",
        causes,
        steps,
        tags,
      };
    });
  }

  // ✅ 2) Places workshops ONLY when user explicitly asks for a workshop
  let verified_workshops = [];

  const wantsPlaces =
    typeof allowPlaces === "boolean" ? allowPlaces : detectPlacesIntent(userQuery);

  if (!wantsPlaces) {
    return { verified_data, verified_workshops: [] };
  }

  try {
    const placesMax = Number(process.env.PLACES_MAX_RESULTS || 5);
    verified_workshops = await googlePlacesWorkshops(
      userLocation,
      locale,
      placesMax,
      placesRadiusMeters
    );
  } catch (e) {
    console.error("Workshops search error:", e?.message || e);
    verified_workshops = [];
  }

  return { verified_data, verified_workshops };
}
