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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB
  },
});

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---- Health ----
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", status: "up" });
});

// ---- Text ----
// Expects: { text: string, history?: array, locale?: string }
app.post("/api/text-diagnose", async (req, res) => {
  try {
    const text =
      (req.body?.text ?? req.body?.message ?? "").toString().trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const locale = (req.body?.locale ?? "auto").toString();

    if (!text) {
      return res.status(400).json({ ok: false, error: "NO_TEXT" });
    }

    const out = await diagnoseText({ text, history, locale });
    res.json({ ok: true, reply: out.reply, meta: out.meta ?? {} });
  } catch (e) {
    console.error("TEXT_DIAGNOSE_ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      detail: String(e?.message ?? e),
    });
  }
});

// ---- Image ----
// multipart/form-data: field name MUST be "image"
// Also accepts text fields: text, locale
app.post(
  "/api/image-diagnose",
  upload.single("image"),
  async (req, res) => {
    try {
      const file = req.file; // multer puts it here
      const text = (req.body?.text ?? "").toString().trim();
      const locale = (req.body?.locale ?? "auto").toString();

      if (!file || !file.buffer) {
        return res.status(400).json({ ok: false, error: "NO_IMAGE" });
      }

      const out = await diagnoseImage({
        imageBuffer: file.buffer,
        mimeType: file.mimetype || "image/jpeg",
        text,
        locale,
      });

      res.json({ ok: true, reply: out.reply, meta: out.meta ?? {} });
    } catch (e) {
      console.error("IMAGE_DIAGNOSE_ERROR:", e);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        detail: String(e?.message ?? e),
      });
    }
  }
);

// ---- Audio ----
// multipart/form-data: field name MUST be "audio"
// Also accepts text fields: text, locale
app.post(
  "/api/audio-diagnose",
  upload.single("audio"),
  async (req, res) => {
    try {
      const file = req.file;
      const text = (req.body?.text ?? "").toString().trim();
      const locale = (req.body?.locale ?? "auto").toString();

      if (!file || !file.buffer) {
        return res.status(400).json({ ok: false, error: "NO_AUDIO" });
      }

      const out = await diagnoseAudio({
        audioBuffer: file.buffer,
        mimeType: file.mimetype || "audio/m4a",
        text,
        locale,
      });

      res.json({
        ok: true,
        reply: out.reply,
        transcript: out.transcript ?? "",
        meta: out.meta ?? {},
      });
    } catch (e) {
      console.error("AUDIO_DIAGNOSE_ERROR:", e);
      res.status(500).json({
        ok: false,
        error: "SERVER_ERROR",
        detail: String(e?.message ?? e),
      });
    }
  }
);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`FixLens Brain API listening on port ${port}`);
});
