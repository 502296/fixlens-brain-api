// server.js — FixLens Brain API v3.0.0
// Clean server:
// - Stable API routes
// - Modern request handling
// - CORS allowlist support
// - Health check
// - Optional Places debug endpoint
// - Timeout guard
// - Clean shutdown

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

function getDebugFlag(req) {
  return (
    Boolean(req.body?.debug) ||
    String(req.headers["x-fixlens-debug"] || "") === "1" ||
    String(req.query?.debug || "") === "1"
  );
}

function buildRequestDebugSnapshot(req, routeName) {
  const body = req.body || {};
  const userLocation = safePick(body, ["user_location", "location", "gps", "latlng"]);
  const locale = safePick(body, ["locale", "lang", "language"]);
  const text = safePick(body, ["text", "message", "prompt", "input", "query"]);

  return {
    route: routeName,
    origin: req.headers.origin || null,
    locale: locale || null,
    user_location_type: userLocation == null ? null : typeof userLocation,
    user_location: userLocation || null,
    text_preview: typeof text === "string" ? text.slice(0, 160) : null,
    has_image: Boolean(body?.image_base_64 || body?.image_base64 || body?.image),
    has_audio: Boolean(body?.audio_base_64 || body?.audio_base64 || body?.audio),
    audio_kind: body?.audio_kind || null,
    history_len: Array.isArray(body?.history) ? body.history.length : 0,
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
        "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri",
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
  }));
}

/* =========================================================
   ROUTES
========================================================= */
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
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
    time: new Date().toISOString(),
    has_google_places_key: Boolean(GOOGLE_PLACES_API_KEY),
    has_openai_key: Boolean(OPENAI_API_KEY),
    allowed_origins_count: allowedOrigins.length,
  });
});

app.post("/api/places", async (req, res) => {
  try {
    const userText = extractUserText(req.body);
    const query = hasAnyText(userText) ? userText : "auto repair shop";
    const lang = String(req.body?.language || req.body?.locale || "en").trim() || "en";

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

    return res.status(200).json(output);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || `Unexpected error in ${routeName}`;
    console.error(`${routeName} error:`, { status, message });
    return res.status(status).json({
      ok: false,
      error: message,
      status,
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

  console.error("Unhandled error:", { status, message });

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
