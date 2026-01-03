// server.js
import express from "express";
import cors from "cors";
import { doctorReply } from "./service.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", hint: "Use /health or POST /api/chat" });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", time: new Date().toISOString() });
});

app.post("/api/chat", async (req, res) => processRequest(req, res));
app.post("/api/diagnose", async (req, res) => processRequest(req, res));
app.post("/api/dia", async (req, res) => processRequest(req, res));
app.post("/v1/doctor", async (req, res) => processRequest(req, res));

async function processRequest(req, res) {
  try {
    const { text, image, sessionId, history, locale, audio } = req.body || {};

    // image can be: base64 string OR {base64, mime}
    const imageObj =
      typeof image === "string"
        ? { base64: image, mime: "image/jpeg" }
        : image && typeof image.base64 === "string"
        ? { base64: image.base64, mime: image.mime || "image/jpeg" }
        : null;

    // audio can be: {base64, mime} OR null
    const audioObj =
      audio && typeof audio.base64 === "string"
        ? { base64: audio.base64, mime: audio.mime || "audio/m4a" }
        : null;

    const hasText = typeof text === "string" && text.trim().length > 0;

    // ✅ Provide a strong default instruction if text is empty but media exists
    let safeText = hasText ? text.trim() : "";

    if (!safeText && audioObj) {
      safeText =
        "Analyze the attached car audio recording. " +
        "Return max 3 likely causes, say whether it's safe to keep driving, " +
        "and ask at most ONE follow-up question. " +
        "Reply in the user's language.";
    } else if (!safeText && imageObj) {
      safeText =
        "Analyze the attached car photo. " +
        "Return max 3 likely causes, say whether it's safe to keep driving, " +
        "and ask at most ONE follow-up question. " +
        "Reply in the user's language.";
    }

    if (!safeText) {
      return res.status(200).json({
        ok: false,
        text: "Missing input (text/image/audio).",
        language: (locale || "en").toString(),
        error: "MISSING_INPUT",
        meta: {},
      });
    }

    const result = await doctorReply({
      text: safeText,
      locale: (locale || "en").toString(),
      history: Array.isArray(history) ? history : [],
      image: imageObj,
      audio: audioObj,
      sessionId,
    });

    if (!result.ok) {
      return res.status(200).json({
        ok: false,
        text: result.reply || "AI service is not reachable right now.",
        language: result.language || (locale || "en").toString(),
        transcript: result.transcript || null,
        error: result.error || "UNKNOWN",
        meta: result.meta || {},
      });
    }

    return res.status(200).json({
      ok: true,
      text: result.reply,
      language: result.language || (locale || "en").toString(),
      transcript: result.transcript || null,
      meta: result.meta || {},
    });
  } catch (e) {
    console.error("Critical Server Error:", e);
    return res.status(200).json({
      ok: false,
      text: "Internal Server Error. Please try again.",
      language: "en",
      error: "SERVER_ERROR",
      message: e?.message || "Unknown",
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FixLens Brain running on port ${PORT}`));
