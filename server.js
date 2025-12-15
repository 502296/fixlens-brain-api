import express from "express";
import cors from "cors";
import multer from "multer";

import { diagnoseText, diagnoseImage, diagnoseAudio } from "./lib/service.js";

const app = express();

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" })); // للنص فقط

// ---------- Health ----------
app.get("/", (req, res) => {
  res.send("FixLens Brain API is running ✅");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ---------- Multer (memory) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

// ---------- Routes ----------

// TEXT
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const out = await diagnoseText({ message, preferredLanguage, vehicleInfo });
    res.json(out);
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({ error: "Text diagnosis failed", details: err?.message || String(err) });
  }
});

// IMAGE (Flutter sends field name: image)
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image diagnosis failed", details: "No image" });
    }

    const message = (req.body?.message || "").toString();
    const preferredLanguage = req.body?.preferredLanguage?.toString();
    const vehicleInfo = req.body?.vehicleInfo?.toString();

    // ✅ Fix MIME (avoid application/octet-stream)
    const mime = req.file.mimetype && req.file.mimetype !== "application/octet-stream"
      ? req.file.mimetype
      : "image/jpeg";

    const imageBase64 = req.file.buffer.toString("base64");

    const out = await diagnoseImage({
      message,
      preferredLanguage,
      vehicleInfo,
      imageBase64,
      imageMime: mime,
      imageUrl: null,
    });

    res.json(out);
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({ error: "Image diagnosis failed", details: err?.message || String(err) });
  }
});

// AUDIO (Flutter sends field name: audio)
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Audio diagnosis failed", details: "No audio" });
    }

    const message = (req.body?.message || "").toString();
    const preferredLanguage = req.body?.preferredLanguage?.toString();
    const vehicleInfo = req.body?.vehicleInfo?.toString();

    // ✅ Force safe audio mime
    let mime = (req.file.mimetype || "").toLowerCase();
    if (!mime || mime === "application/octet-stream") {
      mime = "audio/webm";
    }

    const audioBase64 = req.file.buffer.toString("base64");

    const out = await diagnoseAudio({
      message,
      preferredLanguage,
      vehicleInfo,
      audioBase64,
      audioMime: mime,
    });

    res.json(out);
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res.status(500).json({ error: "Audio diagnosis failed", details: err?.message || String(err) });
  }
});

// ---------- Global error handler ----------
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({ error: "Server error", details: err?.message || String(err) });
});

// ---------- Listen (Railway) ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});
