import express from "express";
import cors from "cors";
import multer from "multer";

import { diagnoseText, diagnoseImage, diagnoseAudio } from "./lib/service.js";

const app = express();

// ✅ CORS
app.use(cors());

// ✅ JSON bodies (text endpoint)
app.use(express.json({ limit: "25mb" }));

// ✅ Multipart (image/audio)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// ✅ Health checks (Important for Railway)
app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ============================
// ✅ TEXT: POST /api/diagnose
// Body: { message, preferredLanguage, vehicleInfo }
// ============================
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const result = await diagnoseText({ message, preferredLanguage, vehicleInfo });
    res.status(200).json(result);
  } catch (err) {
    console.error("TEXT DIAG ERROR:", err);
    res.status(500).json({ error: "Text diagnosis failed", details: err?.message || String(err) });
  }
});

// ============================
// ✅ IMAGE: POST /api/image-diagnose
// multipart:
// - field "image" (file)
// - fields: message, preferredLanguage, vehicleInfo
// ============================
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No image uploaded. Field name must be 'image'." });
    }

    // Convert to base64
    const imageBase64 = file.buffer.toString("base64");
    const imageMime = file.mimetype || "image/jpeg";

    const result = await diagnoseImage({
      message,
      preferredLanguage,
      vehicleInfo,
      imageBase64,
      imageMime,
    });

    res.status(200).json(result);
  } catch (err) {
    console.error("IMAGE DIAG ERROR:", err);
    res.status(500).json({ error: "Image diagnosis failed", details: err?.message || String(err) });
  }
});

// ============================
// ✅ AUDIO: POST /api/audio-diagnose
// multipart:
// - field "audio" (file)
// - fields: message, preferredLanguage, vehicleInfo
// ============================
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: "No audio uploaded. Field name must be 'audio'." });
    }

    const audioBase64 = file.buffer.toString("base64");
    const audioMime = file.mimetype || "audio/webm";

    const result = await diagnoseAudio({
      message,
      preferredLanguage,
      vehicleInfo,
      audioBase64,
      audioMime,
    });

    res.status(200).json(result);
  } catch (err) {
    console.error("AUDIO DIAG ERROR:", err);
    res.status(500).json({ error: "Audio diagnosis failed", details: err?.message || String(err) });
  }
});

// ✅ Global error handler
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({ error: "Server error", details: err?.message || String(err) });
});

// ✅ Railway Port
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});
