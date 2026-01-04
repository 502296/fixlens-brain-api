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

    const {
      text,
      image, // base64 string OR { base64, mime }
      audio, // { base64, mime } OR null
      locale = "en",
      history = [],
      sessionId = "",
      audioTranscript = "",
    } = body;

    const imageObj =
      typeof image === "string"
        ? { base64: image, mime: "image/jpeg" }
        : image && typeof image.base64 === "string"
        ? { base64: image.base64, mime: image.mime || "image/jpeg" }
        : null;

    const audioObj =
      audio && typeof audio.base64 === "string"
        ? { base64: audio.base64, mime: audio.mime || "audio/m4a" }
        : null;

    const userText = safeStr(text).trim();

    // English-only fallback; the model will reply in the user's language via prompt rules.
    let safeTextFinal = userText;

    if (!safeTextFinal && audioObj) {
      safeTextFinal =
        "Analyze the attached car audio recording. Return max 3 likely causes, say whether it's safe to keep driving now, and ask at most ONE follow-up question if needed.";
    }

    if (!safeTextFinal && imageObj) {
      safeTextFinal =
        "Analyze the attached car photo. Return max 3 likely causes, say whether it's safe to keep driving now, and ask at most ONE follow-up question if needed.";
    }

    if (!safeTextFinal) {
      safeTextFinal =
        "Describe the car problem briefly: symptoms, any warning lights, and when it happens (acceleration, braking, or idling).";
    }

    const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
    const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

    const result = await handleFixLensRequest({
      text: safeTextFinal,
      locale: normalizeLocale(locale),
      history: Array.isArray(history) ? history : [],
      sessionId: safeStr(sessionId),

      hasImage: Boolean(imageBuffer),
      imageBuffer,
      imageMime: imageObj?.mime || "image/jpeg",

      hasAudio: Boolean(audioBuffer),
      audioBuffer,
      audioMime: audioObj?.mime || "audio/m4a",

      audioTranscript: safeStr(audioTranscript),
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
      transcript: safeStr(result.transcript || ""),
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
