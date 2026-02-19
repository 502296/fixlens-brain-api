// search.js — Local KB + Smart Google Places (Professional Stable Build)

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

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
   LOAD LOCAL KB ONCE
========================================================= */
let KB = [];
let KB_LOADED = false;

function loadKBOnce() {
  if (KB_LOADED) return;
  KB_LOADED = true;

  try {
    if (!fs.existsSync(DATA_DIR)) return;

    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));

    for (const f of files) {
      const raw = fs.readFileSync(path.join(DATA_DIR, f), "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        KB.push(...parsed.map(x => ({ ...x, __source: f })));
      } else if (parsed?.items) {
        KB.push(...parsed.items.map(x => ({ ...x, __source: f })));
      } else if (typeof parsed === "object") {
        KB.push({ ...parsed, __source: f });
      }
    }
  } catch (e) {
    console.error("KB load error:", e?.message);
    KB = [];
  }
}

/* =========================================================
   UTILITIES
========================================================= */
function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => {
    const k = keyFn(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function scoreMatch(query, recordText) {
  const q = normalizeText(query);
  const text = normalizeText(recordText);

  if (!q || !text) return 0;

  let score = 0;

  if (text.includes(q)) score += 10;

  const tokens = q.split(" ").filter(Boolean);
  for (const t of tokens) {
    if (text.includes(t)) score += 2;
  }

  return score;
}

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
    ]
      .filter(Boolean)
      .join(" ")
  );
}

/* =========================================================
   GOOGLE PLACES (SMART + SAFE)
========================================================= */
const PLACES_CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const TIMEOUT = 7000;

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
  PLACES_CACHE.set(key, {
    value,
    expiry: Date.now() + CACHE_TTL,
  });
}

function parseLatLng(input) {
  if (!input) return null;
  if (typeof input === "object") {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }
  return null;
}

function extractZip(text = "") {
  const m = String(text).match(/\b\d{5}\b/);
  return m ? m[0] : "";
}

function looksLikePlacesIntent(q = "") {
  const t = String(q).toLowerCase();
  return (
    t.includes("ورشة") ||
    t.includes("garage") ||
    t.includes("mechanic") ||
    t.includes("near me") ||
    t.includes("اقرب") ||
    t.includes("عنوان")
  );
}

async function searchPlaces(query, location, locale) {
  if (!process.env.GOOGLE_PLACES_API_KEY) return [];

  const cacheKey = `${query}::${JSON.stringify(location)}::${locale}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const gps = parseLatLng(location);
  const zip = extractZip(query);

  const languageCode = locale?.split("-")[0] || "en";

  const body = {
    textQuery: query,
    maxResultCount: 5,
    languageCode,
  };

  if (gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius: 25000,
      },
    };
  } else if (zip) {
    body.textQuery = `${query} ${zip}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const f = await ensureFetch();
    const res = await f(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask":
            "places.displayName,places.formattedAddress,places.googleMapsUri,places.id",
        },
        body: JSON.stringify(body),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];

    const places = (data.places || []).map(p => ({
      name: p.displayName?.text || "",
      address: p.formattedAddress || "",
      maps_url: p.googleMapsUri || "",
      place_id: p.id || "",
    }));

    const deduped = uniqBy(
      places,
      x => x.place_id || `${x.name}::${x.address}`
    );

    cacheSet(cacheKey, deduped);
    return deduped;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(
  userQuery,
  userLocation,
  opts = {}
) {
  loadKBOnce();

  const { locale = "en", allowPlaces = false } = opts;

  /* ---------- LOCAL SEARCH ---------- */
  let verified_data = [];

  if (userQuery && KB.length > 0) {
    const scored = KB.map(r => {
      const score = scoreMatch(userQuery, recordToText(r));
      return { r, score };
    })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    verified_data = scored.map(x => ({
      title: x.r.title || x.r.problem || "Verified item",
      source: x.r.__source || "data",
      causes: x.r.likely_causes || x.r.causes || "",
      checks: x.r.recommended_checks || x.r.checks || "",
      steps: x.r.steps || "",
      tags: x.r.tags || "",
    }));
  }

  /* ---------- PLACES SEARCH ---------- */
  let verified_workshops = [];

  if (allowPlaces && looksLikePlacesIntent(userQuery)) {
    verified_workshops = await searchPlaces(
      userQuery,
      userLocation,
      locale
    );
  }

  return {
    verified_data,
    verified_workshops,
  };
}
