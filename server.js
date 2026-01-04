// server.js
import express from "express";
import cors from "cors";
import { handleFixLensRequest } from "./service.js";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ---------- Helpers ----------
function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function stripDataUrl(b64) {
  // supports: "data:image/jpeg;base64,AAAA" or raw base64 "AAAA"
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

// ---------- Routes ----------
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
  });
});

app.post("/api/chat", (req, res) => processRequest(req, res));
app.post("/api/diagnose", (req, res) => processRequest(req, res));
app.post("/api/dial", (req, res) => processRequest(req, res));
app.post("/v1/doctor", (req, res) => processRequest(req, res));

// ---------- Main handler ----------
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
    } = body;

    // 1) Build image object FIRST
    const imageObj =
      typeof image === "string"
        ? { base64: image, mime: "image/jpeg" }
        : image && typeof image.base64 === "string"
        ? { base64: image.base64, mime: image.mime || "image/jpeg" }
        : null;

    // 2) Build audio object FIRST
    const audioObj =
      audio && typeof audio.base64 === "string"
        ? { base64: audio.base64, mime: audio.mime || "audio/m4a" }
        : null;

    // 3) Build safe text (if empty but media exists)
    const hasText = typeof text === "string" && text.trim().length > 0;
    let safeText = hasText ? text.trim() : "";

    if (!safeText && audioObj) {
      safeText =
        "Analyze the attached car audio recording. Return max 3 likely causes, say whether it's safe to keep driving, and ask at most ONE follow-up question if needed.";
    }

    if (!safeText && imageObj) {
      safeText =
        "Analyze the attached car photo. Return max 3 likely causes, say whether it's safe to keep driving, and ask at most ONE follow-up question if needed.";
    }

    if (!safeText) {
      safeText =
        "Describe the car problem briefly. Include symptoms, warnings on the dashboard, and whether the issue is worse when accelerating, braking, or idling.";
    }

    // 4) Convert base64 to buffers
    const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
    const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

    // 5) Call your Pro brain
    const result = await handleFixLensRequest({
      text: safeText,
      locale,
      history,
      sessionId,

      hasImage: Boolean(imageBuffer),
      imageBuffer: imageBuffer,
      imageMime: imageObj?.mime || "image/jpeg",

      hasAudio: Boolean(audioBuffer),
      audioBuffer: audioBuffer,
      audioMime: audioObj?.mime || "audio/m4a",

      // if your flutter sends a transcript sometimes, it can pass it too:
      audioTranscript: safeStr(body.audioTranscript || ""),
    });

    // 6) Standard response
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

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
