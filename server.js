// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "os";
import fs from "fs";

import { diagnoseText, diagnoseImage, diagnoseAudio } from "./lib/service.js";

const app = express();

// ---------- Middlewares ----------
app.use(cors());
app.use(express.json({ limit: "2mb" })); // للنص فقط

// ✅ Timeouts حتى ما يصير 502 بسهولة
app.use((req, res, next) => {
  res.setTimeout(240000); // 4 minutes
  next();
});

// ✅ Multer: disk storage (أفضل للثبات من memory)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safeName = (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
      cb(null, `fixlens_${Date.now()}_${safeName}`);
    },
  }),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

// ---------- Health ----------
app.get("/", (req, res) => res.status(200).send("FixLens Brain API is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ---------- TEXT ----------
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    const out = await diagnoseText({ message, preferredLanguage, vehicleInfo });
    res.status(200).json(out);
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({ error: "Text diagnosis failed", details: err?.message || String(err) });
  }
});

// ---------- IMAGE (file path) ----------
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  const file = req.file;
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    if (!file?.path) {
      return res.status(400).json({ error: "Image diagnosis failed", details: "No image" });
    }

    // ✅ مرّر المسار بدل buffer
    const out = await diagnoseImage({
      message,
      preferredLanguage,
      vehicleInfo,
      imagePath: file.path,
      imageMime: file.mimetype,
      imageOriginalName: file.originalname,
    });

    res.status(200).json(out);
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({ error: "Image diagnosis failed", details: err?.message || String(err) });
  } finally {
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
  }
});

// ---------- AUDIO (file path) ----------
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  const file = req.file;
  try {
    const { message, preferredLanguage, vehicleInfo } = req.body || {};
    if (!file?.path) {
      return res.status(400).json({ error: "Audio diagnosis failed", details: "No audio" });
    }

    // ✅ مرّر المسار بدل buffer
    const out = await diagnoseAudio({
      message,
      preferredLanguage,
      vehicleInfo,
      audioPath: file.path,
      audioMime: file.mimetype,
      audioOriginalName: file.originalname,
    });

    res.status(200).json(out);
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res.status(500).json({ error: "Audio diagnosis failed", details: err?.message || String(err) });
  } finally {
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
  }
});

// ---------- Railway listen ----------
const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log("FixLens Brain running on port", PORT)
);

// ✅ timeout على مستوى السيرفر
server.setTimeout(240000);
