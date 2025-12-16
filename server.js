// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs";

import {
  diagnoseText,
  diagnoseImage,
  diagnoseAudio,
} from "./lib/service.js";

const app = express();

/* ===============================
   BASIC CONFIG
================================ */
app.use(cors());
app.use(express.json({ limit: "2mb" })); // للنص فقط

// ⏱️ Timeout عالي لتجنب 502
app.use((req, res, next) => {
  res.setTimeout(240000); // 4 دقائق
  next();
});

/* ===============================
   MULTER (Disk storage فقط)
   يمنع RAM crash
================================ */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safe =
        (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
      cb(null, `fixlens_${Date.now()}_${safe}`);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/* ===============================
   HEALTH
================================ */
app.get("/", (_, res) =>
  res.status(200).send("FixLens Brain API running ✅")
);

app.get("/health", (_, res) =>
  res.status(200).json({ ok: true })
);

/* ===============================
   TEXT
================================ */
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};

    if (!message || !message.trim()) {
      return res
        .status(400)
        .json({ error: "Message is required" });
    }

    const out = await diagnoseText({
      message,
      preferredLanguage,
      vehicleInfo,
    });

    res.status(200).json(out);
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({
      error: "Text diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

/* ===============================
   IMAGE
================================ */
app.post(
  "/api/image-diagnose",
  upload.single("image"),
  async (req, res) => {
    const file = req.file;

    try {
      if (!file || !file.path) {
        return res
          .status(400)
          .json({ error: "No image received" });
      }

      const { message, preferredLanguage, vehicleInfo } = req.body || {};

      const imageBuffer = fs.readFileSync(file.path);

      const out = await diagnoseImage({
        message,
        preferredLanguage,
        vehicleInfo,
        imageBuffer,
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
    } finally {
      try {
        if (file?.path) fs.unlinkSync(file.path);
      } catch {}
    }
  }
);

/* ===============================
   AUDIO (🔥 FIXED)
================================ */
app.post(
  "/api/audio-diagnose",
  upload.single("audio"),
  async (req, res) => {
    const file = req.file;

    try {
      if (!file || !file.path) {
        return res
          .status(400)
          .json({ error: "No audio received" });
      }

      const { message, preferredLanguage, vehicleInfo } = req.body || {};

      // ✅ هذا هو الحل الجذري
      const audioBuffer = fs.readFileSync(file.path);
      if (!audioBuffer || !audioBuffer.length) {
        throw new Error("Audio buffer is empty");
      }

      const out = await diagnoseAudio({
        message,
        preferredLanguage,
        vehicleInfo,
        audioBuffer,
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
    } finally {
      try {
        if (file?.path) fs.unlinkSync(file.path);
      } catch {}
    }
  }
);

/* ===============================
   START SERVER (Railway)
================================ */
const PORT = Number(process.env.PORT || 8080);

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});

// ⏱️ timeout على مستوى السيرفر
server.setTimeout(240000);
