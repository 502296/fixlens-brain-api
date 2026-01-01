// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";

import { textBrain } from "./service.js";
import { imageBrain } from "./service_image.js";
import { audioBrain } from "./service_audio.js";

const app = express();
const upload = multer({ dest: "/tmp" });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.send("FixLens Brain API is running.");
});

// --------------------
// TEXT DIAGNOSE
// Flutter -> POST /api/diagnose
// --------------------
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, history, meta } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "NO_TEXT" });
    }

    const result = await textBrain({
      message,
      history: Array.isArray(history) ? history : [],
      meta: meta || {},
    });

    res.json({ ok: true, reply: result.reply });
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({
      ok: false,
      error: "TEXT_FAILURE",
      detail: err.message,
    });
  }
});

// --------------------
// IMAGE DIAGNOSE
// Flutter -> POST /api/image-diagnose
// --------------------
app.post(
  "/api/image-diagnose",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "NO_IMAGE" });
      }

      const result = await imageBrain({
        imagePath: req.file.path,
        message: req.body?.message || "",
      });

      fs.unlink(req.file.path, () => {});
      res.json({ ok: true, reply: result.reply });
    } catch (err) {
      console.error("IMAGE ERROR:", err);
      res.status(500).json({
        ok: false,
        error: "IMAGE_FAILURE",
        detail: err.message,
      });
    }
  }
);

// --------------------
// AUDIO DIAGNOSE
// Flutter -> POST /api/audio-diagnose
// --------------------
app.post(
  "/api/audio-diagnose",
  upload.single("audio"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ ok: false, error: "NO_AUDIO" });
      }

      const result = await audioBrain({
        audioPath: req.file.path,
      });

      fs.unlink(req.file.path, () => {});
      res.json({ ok: true, reply: result.reply });
    } catch (err) {
      console.error("AUDIO ERROR:", err);
      res.status(500).json({
        ok: false,
        error: "AUDIO_FAILURE",
        detail: err.message,
      });
    }
  }
);

// --------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
