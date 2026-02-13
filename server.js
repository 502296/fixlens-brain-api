// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { handleFixLensRequest } from "./service.js";

const app = express();

// Trust proxy (Render behind proxy)
app.set("trust proxy", 1);

// CORS allowlist (optional)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.length === 0) return cb(null, true);
      return allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS_NOT_ALLOWED"));
    },
    credentials: true,
  })
);

app.use(morgan("combined"));
app.use(express.json({ limit: "25mb" }));

// =====================
// Helpers
// =====================
const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function extractUserText(body) {
  if (!body) return "";
  if (typeof body.text === "string") return body.text;
  if (typeof body.message === "string") return body.message;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.input === "string") return body.input;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last?.content === "string") return last.content;
    if (Array.isArray(last?.content)) {
      const t = last.content.find((c) => c?.type === "text")?.text;
      if (typeof t === "string") return t;
    }
  }
  return "";
}

function hasAnyText(x) {
  return typeof x === "string" && x.trim().length > 0;
}

// =====================
// OPTIONAL: Direct Places endpoint (for quick debugging only)
// NOTE: This endpoint is NOT used by the app flow.
// =====================
async function googlePlacesSearchText(textQuery, languageCode = "en") {
  if (!GOOGLE_PLACES_API_KEY) {
    const err = new Error("GOOGLE_PLACES_API_KEY is missing on the server");
    err.status = 500;
    throw err;
  }

  const q = (textQuery || "").trim();
  const finalQuery = q.length > 0 ? q : "auto repair near me";

  const url = "https://places.googleapis.com/v1/places:searchText";

  const body = {
    textQuery: finalQuery,
    languageCode: languageCode || "en",
    regionCode: "US",
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

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    hint: "Use POST /api/chat or POST /api/fixlens and GET /health",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    time: new Date().toISOString(),
    has_google_places_key: Boolean(GOOGLE_PLACES_API_KEY),
    has_openai_key: Boolean(OPENAI_API_KEY),
  });
});

// ✅ Debug-only Places endpoint
app.post("/api/places", async (req, res) => {
  try {
    const userText = extractUserText(req.body) || req.body?.query || "";
    const query = hasAnyText(userText) ? userText : "auto repair shop";
    const lang = (req.body?.language || "en").toString().trim() || "en";

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
    console.error("Places error:", { status, message });
    return res.status(status).json({ ok: false, error: message, status });
  }
});

// ✅ IMPORTANT: App endpoints ALWAYS return FixLens reply (never "mode: places")
const apiHandler = async (req, res, name) => {
  try {
    const out = await handleFixLensRequest(req);
    return res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || `Unexpected error in ${name}`;
    console.error(`${name} error:`, { status, message });
    return res.status(status).json({ ok: false, error: message, status });
  }
};

app.post("/api/fixlens", (req, res) => apiHandler(req, res, "/api/fixlens"));
app.post("/api/chat", (req, res) => apiHandler(req, res, "/api/chat"));

// 404
app.use((req, res) => {
  res
    .status(404)
    .json({ ok: false, error: "NOT_FOUND", path: req.path, method: req.method });
});

// error handler
app.use((err, req, res, next) => {
  const message = err?.message || "INTERNAL_ERROR";
  const status = message === "CORS_NOT_ALLOWED" ? 403 : 500;
  console.error("Unhandled error:", { status, message });
  res.status(status).json({ ok: false, error: message, status });
});

const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
  console.log(`Google Places key present: ${Boolean(GOOGLE_PLACES_API_KEY)}`);
  console.log(`OpenAI key present: ${Boolean(OPENAI_API_KEY)}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down...");
  server.close(() => process.exit(0));
});
