// server.js — FixLens Brain API (FINAL, stable)
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
  res.json({
    ok: true,
    service: "fixlens-brain-api",
    time: nowISO(),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasSerperKey: Boolean(process.env.SERPER_API_KEY),
  });
});

app.post("/api/chat", (req, res) => processRequest(req, res));
app.post("/api/diagnose", (req, res) => processRequest(req, res));
app.post("/api/dial", (req, res) => processRequest(req, res));
app.post("/v1/doctor", (req, res) => processRequest(req, res));

async function processRequest(req, res) {
  const body = req.body || {};

  try {
    const {
      text = "",
      image = null, // { base64, mime } OR string base64
      audio = null, // { base64, mime }
      locale = "en",
      history = [],
      sessionId = "",
      audioTranscript = "",
      intakeAlreadyAsked = false,

      // optional routing from Flutter
      model = "",
      capability = "", // "text" | "vision" | "audio"
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

    let safeTextFinal = typeof text === "string" ? text.trim() : "";

    // Minimal fallback if user sent only audio/image
    if (!safeTextFinal && audioObj) {
      safeTextFinal =
        "Analyze the attached engine/vehicle noise recording from a car. This is NOT a stereo/speaker/radio issue.";
    }
    if (!safeTextFinal && imageObj) {
      safeTextFinal = "Analyze the attached car photo and describe what it suggests.";
    }
    if (!safeTextFinal) {
      safeTextFinal =
        "Describe the problem briefly: symptoms, any warning lights, and when it happens.";
    }

    const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
    const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

    // avoid treating tiny/empty buffers as real audio
    const hasAudioReal = Boolean(audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000);

    const chosenModel =
      safeStr(model) || (hasAudioReal ? "gpt-4o" : "gpt-5-mini");

    const chosenCapability =
      safeStr(capability) || (hasAudioReal ? "audio" : imageBuffer ? "vision" : "text");

    const normalizedLocale = normalizeLocale(locale);

    const result = await handleFixLensRequest({
      text: safeTextFinal,
      locale: normalizedLocale,
      history: Array.isArray(history) ? history : [],
      sessionId: safeStr(sessionId),

      hasImage: Boolean(imageBuffer),
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

    const outLanguage =
      safeStr(result?.language) || normalizedLocale;

    // ✅ CRITICAL: Always return a usable reply to Flutter (even on ok:false)
    if (!result?.ok) {
      return res.status(200).json({
        ok: false,
        reply: safeStr(result?.reply) || (outLanguage === "ar"
          ? "حصل خطأ بسيط أثناء التحليل. جرّب مرة ثانية."
          : "A small error happened while analyzing. Please try again."),
        language: outLanguage,
        error: result?.error || "SERVICE_ERROR",
        meta: result?.meta || { model: chosenModel, capability: chosenCapability },
      });
    }

    return res.status(200).json({
      ok: true,
      reply: safeStr(result.reply),
      language: outLanguage,
      meta: {
        ...(result.meta || {}),
        model: chosenModel,
        capability: chosenCapability,
      },
    });
  } catch (err) {
    console.error("processRequest error:", err?.message || err);

    // ✅ return 200 + friendly message (Flutter won't look broken)
    return res.status(200).json({
      ok: false,
      reply: "Server error. Please try again in a moment.",
      language: "en",
      error: "PROCESS_REQUEST_FAILED",
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
