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

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(200).json({ ok: false, text: "Missing text input." });
    }

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

    const result = await doctorReply({
      text: text.trim(),
      locale: locale || "en",
      history: Array.isArray(history) ? history : [],
      image: imageObj,
      audio: audioObj,
      sessionId,
    });

    if (!result.ok) {
      return res.status(200).json({
        ok: false,
        text: result.reply || "AI service is not reachable right now.",
        error: result.error || "UNKNOWN",
        meta: result.meta || {},
      });
    }

    return res.status(200).json({
      ok: true,
      text: result.reply,
      meta: result.meta || {},
    });
  } catch (e) {
    console.error("Critical Server Error:", e);
    return res.status(200).json({
      ok: false,
      text: "Internal Server Error. Please try again.",
      error: "SERVER_ERROR",
      message: e?.message || "Unknown",
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FixLens Brain running on port ${PORT}`));
