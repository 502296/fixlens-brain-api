// server.js — FixLens Brain API (FINAL)
import express from "express";
import cors from "cors";
import { handleFixLensRequest } from "./service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function stripDataUrl(b64) {
  const s = safeStr(b64).trim();
  const idx = s.indexOf("base64,");
  return idx >= 0 ? s.slice(idx + "base64,".length) : s;
}

function b64ToBuffer(b64) {
  const cleaned = stripDataUrl(b64);
  if (!cleaned) return null;
  try {
    return Buffer.from(cleaned, "base64");
  } catch {
    return null;
  }
}

function nowISO() {
  return new Date().toISOString();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "fixlens-brain-api",
    hint: "Use /health or POST /api/chat",
    time: nowISO(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", time: nowISO() });
});

app.post("/api/chat", (req, res) => processRequest(req, res));
app.post("/api/diagnose", (req, res) => processRequest(req, res));
app.post("/api/dial", (req, res) => processRequest(req, res));
app.post("/v1/doctor", (req, res) => processRequest(req, res));

async function processRequest(req, res) {
  const body = req.body || {};

  const {
    text = "",
    image = null, // {base64, mime} OR string base64
    audio = null, // {base64, mime}
    locale = "en",
    history = [],
    sessionId = "",
    audioTranscript = "",
    intakeAlreadyAsked = false,

    // optional routing from Flutter:
    model = "", // e.g. gpt-5-mini, gpt-4o
    capability = "", // text|vision|audio
  } = body;

  const normalizedLocale = normalizeLocale(locale);

  // Normalize image/audio objects
  const imageObj =
    typeof image === "string"
      ? { base64: image, mime: "image/jpeg" }
      : image && typeof image.base64 === "string"
      ? { base64: image.base64, mime: image.mime || "image/jpeg" }
      : null;

  const audioObj =
    audio && typeof audio.base64 === "string"
      ? { base64: audio.base64, mime: audio.mime || "audio/mp4" }
      : null;

  // Text fallback if user sent only image/audio
  let userText = typeof text === "string" ? text.trim() : "";
  if (!userText && audioObj) {
    userText =
      "Analyze the attached vehicle noise recording. Focus on mechanical/engine/drivetrain causes.";
  }
  if (!userText && imageObj) {
    userText = "Analyze the attached car photo and infer what it suggests.";
  }
  if (!userText) {
    userText = "Describe the problem briefly: symptoms, any warning lights, and when it happens.";
  }

  const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
  const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

  // avoid tiny buffers being treated as real media
  const hasImageReal = Boolean(imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 10);
  const hasAudioReal = Boolean(audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000);

  // Choose model if none passed
  const chosenModel =
    safeStr(model) ||
    (hasImageReal ? "gpt-4o" : "gpt-5-mini"); // you can change defaults here safely

  const chosenCapability =
    safeStr(capability) ||
    (hasAudioReal ? "audio" : hasImageReal ? "vision" : "text");

  try {
    const result = await handleFixLensRequest({
      text: userText,
      locale: normalizedLocale,
      history: Array.isArray(history) ? history : [],
      sessionId: safeStr(sessionId),

      hasImage: hasImageReal,
      imageBuffer,
      imageMime: imageObj?.mime || "image/jpeg",

      hasAudio: hasAudioReal,
      audioBuffer,
      audioMime: audioObj?.mime || "audio/mp4",

      audioTranscript: safeStr(audioTranscript),
      intakeAlreadyAsked: Boolean(intakeAlreadyAsked),

      model: chosenModel,
      capability: chosenCapability,
    });

    const outLanguage = safeStr(result?.language) || normalizedLocale;

    // Always return a user-visible reply string
    return res.json({
      ok: Boolean(result?.ok),
      reply: safeStr(result?.reply),
      language: outLanguage,
      meta: {
        ...(result?.meta || {}),
        model: chosenModel,
        capability: chosenCapability,
      },
      error: result?.ok ? undefined : result?.error,
    });
  } catch (err) {
    console.error("processRequest fatal:", err?.message || err);
    return res.status(500).json({
      ok: false,
      reply:
        normalizedLocale === "ar"
          ? "صار خطأ بالسيرفر أثناء التحليل. جرّب بعد لحظة."
          : "Server error while analyzing. Please try again in a moment.",
      language: normalizedLocale,
      error: { message: safeStr(err?.message) || "PROCESS_REQUEST_FAILED" },
    });
  }
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
