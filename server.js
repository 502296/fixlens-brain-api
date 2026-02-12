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

// You can set this in Render if you want:
// TEXT_MODEL=gpt-4o-mini (fast/cheap) or gpt-4o (strong)
const INTENT_MODEL = process.env.TEXT_MODEL || "gpt-4o-mini";

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
// Google Places: Text Search (New Places API)
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
    // languageCode optional, but it's nicer to set it.
    languageCode: languageCode || "en",
    regionCode: "US",
    pageSize: 8,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
      // FieldMask is REQUIRED in new Places API:
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.googleMapsUri",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      data?.error?.message || `Google Places error (status ${res.status})`;
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
    ratingsCount:
      typeof p?.userRatingCount === "number" ? p.userRatingCount : null,
    mapsUrl: p?.googleMapsUri || "",
  }));
}

// =====================
// Multilingual intent detection via OpenAI (works in ANY language)
// =====================
async function detectPlacesIntentWithAI(userText) {
  // If OpenAI key missing, we can't do multilingual intent detection
  if (!OPENAI_API_KEY) return { use_places: false };

  // Very short + strict JSON output
  const system = `
You are an intent detector for a mobile app.
Return ONLY valid JSON (no extra text).

Goal: detect if the user is asking for nearby real-world places (shops/services/garages/mechanics/etc).
If yes, provide a clean search query suitable for Google Places "text search".

Rules:
- If user asks for a nearby workshop/mechanic/repair shop, set use_places=true.
- If user asks for "send me a place near me" or "closest X", use_places=true.
- If user is not asking for real-world place recommendations, use_places=false.
- Detect the user's language code (BCP-47 short like: en, ar, es, fr, de, tr, fa, ur, hi, etc). If unsure, use "en".
- Output JSON keys: use_places (boolean), query (string), language (string).
`;

  const user = `User text: ${userText}`;

  const payload = {
    model: INTENT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: user },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    // If detector fails, we just won't use places.
    console.log("Intent detector failed:", data?.error?.message || res.status);
    return { use_places: false };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!hasAnyText(content)) return { use_places: false };

  try {
    const obj = JSON.parse(content);
    const use_places = Boolean(obj?.use_places);
    const query = typeof obj?.query === "string" ? obj.query.trim() : "";
    const language =
      typeof obj?.language === "string" && obj.language.trim()
        ? obj.language.trim()
        : "en";
    return { use_places, query, language };
  } catch {
    return { use_places: false };
  }
}

// =====================
// Routes
// =====================
app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    hint: "Use POST /api/chat or POST /api/fixlens, POST /api/places, and GET /health",
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    time: new Date().toISOString(),
    has_google_places_key: Boolean(GOOGLE_PLACES_API_KEY),
    has_openai_key: Boolean(OPENAI_API_KEY),
    intent_model: INTENT_MODEL,
  });
});

// ✅ Direct Places endpoint (for quick testing)
app.post("/api/places", async (req, res) => {
  try {
    const userText = extractUserText(req.body) || req.body?.query || "";
    const intent = await detectPlacesIntentWithAI(userText);

    // If user didn't ask for places, still allow calling places with raw query for debugging
    const query = hasAnyText(intent?.query) ? intent.query : userText;
    const lang = intent?.language || "en";

    const results = await googlePlacesSearchText(query, lang);
    return res.status(200).json({
      ok: true,
      mode: "places",
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

const apiHandler = async (req, res, name) => {
  try {
    const userText = extractUserText(req.body);

    // ✅ Multilingual Places Auto-Trigger
    if (hasAnyText(userText)) {
      const intent = await detectPlacesIntentWithAI(userText);
      if (intent?.use_places) {
        const query = hasAnyText(intent?.query) ? intent.query : userText;
        const lang = intent?.language || "en";

        console.log(`[${name}] Places intent detected → calling Google Places`, {
          lang,
        });

        const results = await googlePlacesSearchText(query, lang);

        return res.status(200).json({
          ok: true,
          mode: "places",
          query,
          language: lang,
          results,
        });
      }
    }

    // Otherwise, normal FixLens AI flow
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
  console.log(`Intent model: ${INTENT_MODEL}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down...");
  server.close(() => process.exit(0));
});
