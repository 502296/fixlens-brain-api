// server.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";

import { handleFixLensRequest } from "./service.js";

const app = express();

// Railway / proxies
app.set("trust proxy", 1);

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "25mb" }));
app.use(morgan("combined"));

// Multer for multipart (audio/image)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

/**
 * Accepts:
 * 1) JSON:
 *   {
 *     text: "...",
 *     locale: "ar" | "en" | ...,
 *     image_base64: "data:image/jpeg;base64,...." OR raw base64,
 *     audio_base64: "base64..." (m4a/wav/mp3...) OR data:audio/...;base64,
 *     audio_filename: "recording.m4a" (optional)
 *   }
 *
 * 2) multipart/form-data:
 *   fields: text, locale
 *   files: image (jpg/png/webp), audio (m4a/mp3/wav/webm...)
 */
app.post(
  "/api/fixlens",
  upload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      const locale = typeof req.body?.locale === "string" ? req.body.locale : "en";

      const imageFile = req.files?.image?.[0] || null;
      const audioFile = req.files?.audio?.[0] || null;

      const payload = {
        text,
        locale,
        // JSON base64 inputs (if not multipart)
        image_base64: req.body?.image_base64,
        audio_base64: req.body?.audio_base64,
        audio_filename: req.body?.audio_filename,
        // multipart buffers (if provided)
        image_file: imageFile
          ? { buffer: imageFile.buffer, mimetype: imageFile.mimetype, originalname: imageFile.originalname }
          : null,
        audio_file: audioFile
          ? { buffer: audioFile.buffer, mimetype: audioFile.mimetype, originalname: audioFile.originalname }
          : null,
      };

      const out = await handleFixLensRequest(payload);

      res.json({
        ok: true,
        reply: out.reply,
        language: out.language || null,
        meta: out.meta || {},
      });
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("API ERROR:", msg);

      res.status(500).json({
        ok: false,
        error: "INTERNAL_ERROR",
        message: msg,
      });
    }
  }
);

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain API running on port ${port}`);
});
