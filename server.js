import "dotenv/config";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";

import {
  diagnoseText,
  diagnoseImage,
  diagnoseAudio
} from "./lib/service.js";

const app = express();

app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));

// Multer for multipart (image/audio)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "FixLens Brain API", ts: new Date().toISOString() });
});

// TEXT
app.post("/api/diagnose", async (req, res) => {
  try {
    const text = (req.body?.text ?? "").toString().trim();
    const lang = (req.body?.lang ?? "auto").toString().trim();

    if (!text) {
      return res.status(400).json({ ok: false, error: "NO_TEXT" });
    }

    const out = await diagnoseText({ text, lang });
    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("TEXT_ROUTE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// IMAGE (multipart form-data: field name "image")
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    const file = req.file;
    const lang = (req.body?.lang ?? "auto").toString().trim();
    const hint = (req.body?.hint ?? "").toString().trim(); // optional text hint

    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: "NO_IMAGE" });
    }

    const out = await diagnoseImage({
      imageBuffer: file.buffer,
      mimeType: file.mimetype || "image/jpeg",
      lang,
      hint
    });

    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("IMAGE_ROUTE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// AUDIO (multipart form-data: field name "audio")
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const lang = (req.body?.lang ?? "auto").toString().trim();

    if (!file || !file.buffer) {
      return res.status(400).json({ ok: false, error: "NO_AUDIO" });
    }

    const out = await diagnoseAudio({
      audioBuffer: file.buffer,
      mimeType: file.mimetype || "audio/m4a",
      lang
    });

    return res.json({ ok: true, ...out });
  } catch (err) {
    console.error("AUDIO_ROUTE_ERROR:", err);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
