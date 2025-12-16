// server.js
import express from "express";
import cors from "cors";
import multer from "multer";

import {
  diagnoseText,
  diagnoseImage,
  diagnoseAudio,
} from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ============================
// HEALTH CHECK
// ============================
app.get("/", (_req, res) => {
  res.json({ status: "FixLens Brain API running" });
});

// ============================
// TEXT
// ============================
app.post("/diagnose/text", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body;

    const result = await diagnoseText({
      message,
      preferredLanguage,
      vehicleInfo,
    });

    res.json(result);
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({
      error: "Text diagnosis failed",
      details: err.message || String(err),
    });
  }
});

// ============================
// IMAGE
// ============================
app.post(
  "/diagnose/image",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Image file missing" });
      }

      const { message, preferredLanguage, vehicleInfo } = req.body;

      const result = await diagnoseImage({
        message,
        preferredLanguage,
        vehicleInfo,
        imageBuffer: req.file.buffer,
        imageMime: req.file.mimetype,
      });

      res.json(result);
    } catch (err) {
      console.error("IMAGE ERROR:", err);
      res.status(500).json({
        error: "Image diagnosis failed",
        details: err.message || String(err),
      });
    }
  }
);

// ============================
// AUDIO
// ============================
app.post(
  "/diagnose/audio",
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Audio file missing" });
      }

      const { message, preferredLanguage, vehicleInfo } = req.body;

      const result = await diagnoseAudio({
        message,
        preferredLanguage,
        vehicleInfo,
        audioBuffer: req.file.buffer,
        audioMime: req.file.mimetype,
        audioOriginalName: req.file.originalname,
      });

      res.json(result);
    } catch (err) {
      console.error("AUDIO ERROR:", err);
      res.status(500).json({
        error: "Audio diagnosis failed",
        details: err.message || String(err),
      });
    }
  }
);

// ============================
// START SERVER
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
