// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";

import { runTextDiagnosis, runImageDiagnosis, runAudioDiagnosis } from "./service.js";

const app = express();

// --- Middleware
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" })); // for text + small payloads
app.use(express.urlencoded({ extended: true }));

// --- Multer (for file uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// --- Root + health
app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

// --- Text diagnose
app.post("/api/diagnose", async (req, res) => {
  try {
    // Accept multiple client formats
    const text =
      req.body?.text ||
      req.body?.message ||
      req.body?.prompt ||
      req.body?.input ||
      req.body?.query ||
      "";

    if (!String(text).trim()) {
      return res.status(400).json({
        ok: false,
        error: "NO_TEXT",
        hint: "Send JSON like { text: '...' } (or message/prompt/input).",
        receivedKeys: Object.keys(req.body || {}),
      });
    }

    const out = await runTextDiagnosis({ text });
    return res.json({ ok: true, text: out });
  } catch (err) {
    console.error("TEXT_DIAGNOSE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "TEXT_FAILED" });
  }
});

// --- Image diagnose (multipart/form-data)
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    const text =
      req.body?.text ||
      req.body?.message ||
      req.body?.prompt ||
      req.body?.input ||
      "";

    if (!req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: "NO_IMAGE",
        hint: "Send multipart/form-data with field name 'image'. Optional text field: 'text'.",
      });
    }

    const out = await runImageDiagnosis({
      text,
      imageBuffer: req.file.buffer,
      mimeType: req.file.mimetype || "image/jpeg",
    });

    return res.json({ ok: true, text: out });
  } catch (err) {
    console.error("IMAGE_DIAGNOSE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "IMAGE_FAILED" });
  }
});

// --- Audio diagnose (multipart/form-data)
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: "NO_AUDIO",
        hint: "Send multipart/form-data with field name 'audio'.",
      });
    }

    const out = await runAudioDiagnosis({
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype || "audio/m4a",
    });

    return res.json({ ok: true, text: out });
  } catch (err) {
    console.error("AUDIO_DIAGNOSE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "AUDIO_FAILED" });
  }
});

// --- Listen
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
