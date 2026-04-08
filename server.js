// server.js — FixLens Brain API v4.0.0
// Global + stable server
// - Stable API routes
// - Cleaner request normalization
// - Better debug snapshots
// - CORS allowlist support
// - Health check
// - Optional Places debug endpoint
// - Timeout guard
// - Clean shutdown
// - Safer global error handling

import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { handleFixLensRequest } from "./service.js";

const app = express();

/* =========================================================
   CONFIG
========================================================= */
const PORT = Number(process.env.PORT || 8080);
const JSON_LIMIT = process.env.JSON_LIMIT || "35mb";
const API_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS || 22000);

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* =========================================================
   APP BASICS
========================================================= */
app.set("trust proxy", 1);

/* =========================================================
   HELPERS
========================================================= */
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

function hasAnyText(x) {
  return typeof x === "string" && x.trim().length > 0;
}

function safePick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return undefined;
}

function extractUserText(body) {
  if (!body) return "";

  if (typeof body.text === "string") return body.text;
  if (typeof body.message === "string") return body.message;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.input === "string") return body.input;
  if (typeof body.query === "string") return body.query;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];

    if (typeof last?.content === "string") return last.content;

    if (Array.isArray(last?.content)) {
      const textPart = last.content.find((c) => c?.type === "text")?.text;
      if (typeof textPart === "string") return textPart;
    }
  }

  return "";
}

function normalizeLocaleInput(body = {}) {
  return (
    String(
      safePick(body, ["locale", "lang", "language"]) || "en"
    )
      .trim() || "en"
  );
}

function normalizeHistory(body = {}) {
  if (Array.isArray(body?.history)) return body.history;
  if (Array.isArray(body?.messages)) return body.messages;
  return [];
}

function normalizeUserLocation(body = {}) {
  return safePick(body, [
    "user_location",
    "location",
    "gps",
    "latlng",
    "coordinates",
  ]);
}

function normalizeMediaFlags(body = {}) {
  return {
    has_image: Boolean(
      body?.image_base_64 ||
        body?.image_base64 ||
        body?.image ||
        body?.image_url
    ),
    has_audio: Boolean(
      body?.audio_base_64 ||
        body?.audio_base64 ||
        body?.audio ||
        body?.audio_url
    ),
    audio_kind: body?.audio_kind || body?.audio_type || null,
  };
}

function getDebugFlag(req) {
  return (
    Boolean(req.body?.debug) ||
    String(req.headers["x-fixlens-debug"] || "") === "1" ||
    String(req.query?.debug || "") === "1"
  );
}

function buildRequestDebugSnapshot(req, routeName) {
  const body = req.body || {};
  const userLocation = normalizeUserLocation(body);
  const locale = normalizeLocaleInput(body);
  const text = extractUserText(body);
  const history = normalizeHistory(body);
  const media = normalizeMediaFlags(body);

  return {
    route: routeName,
    method: req.method,
    origin: req.headers.origin || null,
    ip:
      req.headers["x-forwarded-for"] ||
      req.ip ||
      null,
    locale: locale || null,
    user_location_type: userLocation == null ? null : typeof userLocation,
    user_location: userLocation || null,
    text_preview: typeof text === "string" ? text.slice(0, 220) : null,
    text_length: typeof text === "string" ? text.length : 0,
    has_image: media.has_image,
    has_audio: media.has_audio,
    audio_kind: media.audio_kind,
    history_len: Array.isArray(history) ? history.length : 0,
    message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
  };
}

function requestSummaryForLogs(req, routeName) {
  const body = req.body || {};
  return {
    route: routeName,
    locale: normalizeLocaleInput(body),
    has_text: hasAnyText(extractUserText(body)),
    has_location: Boolean(normalizeUserLocation(body)),
    has_image: normalizeMediaFlags(body).has_image,
    has_audio: normalizeMediaFlags(body).has_audio,
    history_len: normalizeHistory(body).length,
  };
}

/* =========================================================
   CORS + MIDDLEWARE
========================================================= */
app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("CORS_NOT_ALLOWED"));
    },
    credentials: true,
  })
);

app.use(morgan("combined"));
app.use(express.json({ limit: JSON_LIMIT }));

/* =========================================================
   OPTIONAL GOOGLE PLACES DEBUG
   NOTE:
   This endpoint is only for quick manual server testing.
   The real app flow should use /api/fixlens or /api/chat.
========================================================= */
async function googlePlacesSearchText(textQuery, languageCode = "en") {
  if (!GOOGLE_PLACES_API_KEY) {
    const err = new Error("GOOGLE_PLACES_API_KEY is missing on the server");
    err.status = 500;
    throw err;
  }

  const query = hasAnyText(textQuery) ? textQuery.trim() : "auto repair near me";
  const url = "https://places.googleapis.com/v1/places:searchText";

  const body = {
    textQuery: query,
    languageCode: languageCode || "en",
    pageSize: 8,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri,places.nationalPhoneNumber,places.websiteUri,places.businessStatus",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `Google Places error (status ${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.details = data;
    throw err;
  }

  const places = Array.isArray(data?.places) ? data.places : [];

  return places.slice(0, 6).map((p) => ({
    name: p?.displayName?.text || "Unknown",
    address: p?.formattedAddress || "",
    rating: typeof p?.rating === "number" ? p.rating : null,
    ratingsCount: typeof p?.userRatingCount === "number" ? p.userRatingCount : null,
    mapsUrl: p?.googleMapsUri || "",
    phone: p?.nationalPhoneNumber || "",
    website: p?.websiteUri || "",
    businessStatus: p?.businessStatus || "",
  }));
}

/* =========================================================
   ROUTES
========================================================= */
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    version: "4.0.0",
    endpoints: {
      health: "GET /health",
      fixlens: "POST /api/fixlens",
      chat: "POST /api/chat",
      places_debug: "POST /api/places",
    },
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    version: "4.0.0",
    time: new Date().toISOString(),
    uptime_seconds: Math.round(process.uptime()),
    has_google_places_key: Boolean(GOOGLE_PLACES_API_KEY),
    has_openai_key: Boolean(OPENAI_API_KEY),
    allowed_origins_count: allowedOrigins.length,
    json_limit: JSON_LIMIT,
    api_timeout_ms: API_TIMEOUT_MS,
  });
});

app.post("/api/places", async (req, res) => {
  try {
    const userText = extractUserText(req.body);
    const query = hasAnyText(userText) ? userText : "auto repair shop";
    const lang = normalizeLocaleInput(req.body);

    const results = await googlePlacesSearchText(query, lang);

    return res.status(200).json({
      ok: true,
      mode: "places_debug",
      query,
      language: lang,
      results,
    });
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || "Places request failed";
    console.error("Places debug error:", { status, message });
    return res.status(status).json({ ok: false, error: message, status });
  }
});

/* =========================================================
   MAIN FIXLENS HANDLER
========================================================= */
async function apiHandler(req, res, routeName) {
  const debugFlag = getDebugFlag(req);

  if (debugFlag) {
    console.log("[FixLens][REQ_DEBUG]", buildRequestDebugSnapshot(req, routeName));
  } else {
    console.log("[FixLens][REQ]", requestSummaryForLogs(req, routeName));
  }

  try {
    const output = await Promise.race([
      handleFixLensRequest(req),
      new Promise((_, reject) =>
        setTimeout(() => {
          const e = new Error("REQUEST_TIMEOUT");
          e.status = 504;
          reject(e);
        }, API_TIMEOUT_MS)
      ),
    ]);

    if (debugFlag && output && typeof output === "object") {
      return res.status(200).json({
        ...output,
        _server_debug: {
          route: routeName,
          handled_at: new Date().toISOString(),
        },
      });
    }

    return res.status(200).json(output);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || `Unexpected error in ${routeName}`;
    console.error(`${routeName} error:`, {
      status,
      message,
      debug: debugFlag,
    });

    return res.status(status).json({
      ok: false,
      error: message,
      status,
      route: routeName,
    });
  }
}

app.post("/api/fixlens", (req, res) => apiHandler(req, res, "/api/fixlens"));
app.post("/api/chat", (req, res) => apiHandler(req, res, "/api/chat"));

/* =========================================================
   404 + ERROR HANDLERS
========================================================= */
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path,
    method: req.method,
  });
});

app.use((err, req, res, next) => {
  const message = err?.message || "INTERNAL_ERROR";
  const status = message === "CORS_NOT_ALLOWED" ? 403 : 500;

  console.error("Unhandled error:", {
    status,
    message,
    path: req?.path || null,
    method: req?.method || null,
  });

  return res.status(status).json({
    ok: false,
    error: message,
    status,
  });
});

/* =========================================================
   START + SHUTDOWN
========================================================= */
const server = app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
  console.log(`Google Places key present: ${Boolean(GOOGLE_PLACES_API_KEY)}`);
  console.log(`OpenAI key present: ${Boolean(OPENAI_API_KEY)}`);
  console.log(
    `Allowed origins: ${
      allowedOrigins.length > 0 ? allowedOrigins.join(", ") : "(all)"
    }`
  );
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
