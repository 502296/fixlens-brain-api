// server.js
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
  try {
    const body = req.body || {};

    // ✅ JSON payload with base64 for image/audio
    const {
      text = "",
      image = null, // { base64, mime } OR string base64
      audio = null, // { base64, mime }
      locale = "en",
      history = [],
      sessionId = "",
      audioTranscript = "",
      intakeAlreadyAsked = false, // ✅ NEW (from Flutter)
    } = body;

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

    const userText = typeof text === "string" ? text.trim() : "";
    let safeTextFinal = userText;

    // ✅ Minimal fallback prompt if user sent only image/audio without text
    if (!safeTextFinal && audioObj) {
      safeTextFinal =
        "Analyze the attached engine/vehicle noise recording from a car. This is NOT a stereo/speaker/radio issue.";
    }
    if (!safeTextFinal && imageObj) {
      safeTextFinal =
        "Analyze the attached car photo and describe what it suggests.";
    }
    if (!safeTextFinal) {
      safeTextFinal =
        "Describe the problem briefly: symptoms, any warning lights, and when it happens.";
    }

    const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
    const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

    // ✅ IMPORTANT: avoid treating tiny/empty buffers as real audio
    const hasAudioReal = Boolean(
      audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000
    );

    const result = await handleFixLensRequest({
      text: safeTextFinal,
      locale: normalizeLocale(locale),
      history: Array.isArray(history) ? history : [],
      sessionId: safeStr(sessionId),

      hasImage: Boolean(imageBuffer),
      imageBuffer,
      imageMime: imageObj?.mime || "image/jpeg",

      hasAudio: hasAudioReal,
      audioBuffer,
      audioMime: audioObj?.mime || "audio/mp4",

      audioTranscript: safeStr(audioTranscript),

      // ✅ pass session intake flag
      intakeAlreadyAsked: Boolean(intakeAlreadyAsked),
    });

    if (!result?.ok) {
      return res.status(500).json({
        ok: false,
        error: result?.error || "SERVER_ERROR",
        reply: "",
      });
    }

    return res.json({
      ok: true,
      reply: safeStr(result.reply),
      meta: result.meta || {},
    });
  } catch (err) {
    console.error("processRequest error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "PROCESS_REQUEST_FAILED",
      reply: "",
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
