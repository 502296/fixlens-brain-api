// server.js
import express from "express";
import cors from "cors";
import multer from "multer";

import { diagnoseText, diagnoseImage, diagnoseAudio } from "./lib/service.js";

const app = express();

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: "2mb" })); // للنصوص فقط

// Multer (memory) للـ multipart
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

// ---------- Health ----------
app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ---------- TEXT ----------
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const out = await diagnoseText({ message, preferredLanguage, vehicleInfo });
    res.status(200).json(out);
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({
      error: "Text diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

// ---------- IMAGE (multipart field name: image) ----------
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    const file = req.file; // multer
    const { message, preferredLanguage, vehicleInfo } = req.body || {};

    if (!file || !file.buffer) {
      return res.status(400).json({ error: "Image diagnosis failed", details: "No image" });
    }

    const out = await diagnoseImage({
      message,
      preferredLanguage,
      vehicleInfo,
      imageBuffer: file.buffer,
      imageMime: file.mimetype,
      imageOriginalName: file.originalname,
    });

    res.status(200).json(out);
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

// ---------- AUDIO (multipart field name: audio) ----------
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const { message, preferredLanguage, vehicleInfo } = req.body || {};

    if (!file || !file.buffer) {
      return res.status(400).json({ error: "Audio diagnosis failed", details: "No audio" });
    }

    const out = await diagnoseAudio({
      message,
      preferredLanguage,
      vehicleInfo,
      audioBuffer: file.buffer,
      audioMime: file.mimetype,
      audioOriginalName: file.originalname,
    });

    res.status(200).json(out);
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

// ---------- Global error handler ----------
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({
    error: "Server error",
    details: err?.message || String(err),
  });
});

// ---------- Railway listen ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});
