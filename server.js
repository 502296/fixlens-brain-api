// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "os";
import fs from "fs";

import {
  diagnoseText,
  diagnoseImage,
  diagnoseAudio,
  getDataHealth,
} from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" })); // history ممكن يكبر

// ✅ Safety: always have a server-side timeout for responses
app.use((req, res, next) => {
  res.setTimeout(240000);
  next();
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => {
      const safeName = (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
      cb(null, `fixlens_${Date.now()}_${safeName}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// --------------------
// Language helpers
// --------------------
function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (!c) return null;

  const first = c.split(",")[0].trim();
  if (!first) return null;

  const lower = first.toLowerCase();
  if (lower === "auto") return "auto";

  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(first)) return null;
  return first;
}

function resolvePreferredLanguage(req, bodyPreferred) {
  const bodyLang = normalizeLang(bodyPreferred);
  if (bodyLang) return bodyLang;

  const xLang = normalizeLang(req.headers["x-fixlens-lang"]);
  if (xLang) return xLang;

  const hdr = (req.headers["accept-language"] || "").toString().trim();
  if (hdr) {
    const first = hdr.split(",")[0].trim();
    const h = normalizeLang(first);
    if (h) return h;
  }

  return "en";
}

function setContentLanguage(res, lang) {
  const L = normalizeLang(lang) || "en";
  res.setHeader("Content-Language", L);
}

// --------------------
// ✅ History parser
// --------------------
function parseHistoryAny(history) {
  try {
    if (!history) return [];
    if (Array.isArray(history)) return history;

    // multer multipart => strings
    if (typeof history === "string") {
      const t = history.trim();
      if (!t) return [];
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : [];
    }

    return [];
  } catch {
    return [];
  }
}

// --------------------
// Timeout wrapper (prevents hanging => 502)
// --------------------
function withTimeout(promise, ms, label = "TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// --------------------
// Basic routes
// --------------------
app.get("/", (req, res) => res.status(200).send("FixLens Brain API is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.get("/health/data", (req, res) => {
  try {
    const out = getDataHealth();
    res.status(200).json(out);
  } catch (err) {
    console.error("DATA HEALTH ERROR:", err);
    res.status(200).json({
      ok: false,
      error: "Data health failed",
      details: err?.message || String(err),
    });
  }
});

// ---------- TEXT ----------
app.post("/api/diagnose", async (req, res) => {
  const started = Date.now();
  try {
    const { message, preferredLanguage, vehicleInfo, mode, history, consentGranted } = req.body || {};
    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

    const out = await withTimeout(
      diagnoseText({
        message,
        preferredLanguage: resolvedLang,
        vehicleInfo,
        history: parseHistoryAny(history),
        mode: mode || "doctor",
        consentGranted: Boolean(consentGranted), // ✅ Stage 2
      }),
      60000,
      "TEXT_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);
  } catch (err) {
    console.error("TEXT ERROR:", { err: err?.message || String(err), ms: Date.now() - started });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.startsWith("ar")
        ? "FixLens Brain مشغول الآن أو لم يستطع الرد. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
      language: resolvedLang,
      error: "Text diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

// ---------- IMAGE ----------
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  const started = Date.now();
  const file = req.file;

  try {
    const { message, preferredLanguage, vehicleInfo, mode, history, consentGranted } = req.body || {};
    if (!file?.path) {
      const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);
      setContentLanguage(res, resolvedLang);
      return res.status(200).json({
        ok: false,
        error: "Image diagnosis failed",
        details: "No image",
        language: resolvedLang,
      });
    }

    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);
    const imageBuffer = fs.readFileSync(file.path);

    const out = await withTimeout(
      diagnoseImage({
        message,
        preferredLanguage: resolvedLang,
        vehicleInfo,
        history: parseHistoryAny(history),
        imageBuffer,
        imageMime: file.mimetype,
        mode: mode || "doctor",
        consentGranted: String(consentGranted).toLowerCase() === "true" || consentGranted === true, // ✅ Stage 2
      }),
      60000,
      "IMAGE_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);
  } catch (err) {
    console.error("IMAGE ERROR:", { err: err?.message || String(err), ms: Date.now() - started });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.startsWith("ar")
        ? "FixLens Brain تعذر عليه تحليل الصورة الآن. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain couldn’t analyze the image right now. Please retry in a moment.",
      language: resolvedLang,
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  } finally {
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
  }
});

// ---------- AUDIO ----------
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  const started = Date.now();
  const file = req.file;

  try {
    const { message, preferredLanguage, vehicleInfo, mode, history, consentGranted } = req.body || {};
    if (!file?.path) {
      const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);
      setContentLanguage(res, resolvedLang);
      return res.status(200).json({
        ok: false,
        error: "Audio diagnosis failed",
        details: "No audio file received",
        language: resolvedLang,
      });
    }

    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

    const audioBuffer = fs.readFileSync(file.path);
    if (!audioBuffer || audioBuffer.length < 200) {
      setContentLanguage(res, resolvedLang);
      return res.status(200).json({
        ok: false,
        error: "Audio diagnosis failed",
        details: "Audio too small or empty",
        language: resolvedLang,
      });
    }

    const out = await withTimeout(
      diagnoseAudio({
        message,
        preferredLanguage: resolvedLang,
        vehicleInfo,
        history: parseHistoryAny(history),
        audioBuffer,
        audioMime: file.mimetype,
        audioOriginalName: file.originalname,
        mode: mode || "doctor",
        consentGranted: String(consentGranted).toLowerCase() === "true" || consentGranted === true, // ✅ Stage 2
      }),
      90000,
      "AUDIO_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);
  } catch (err) {
    console.error("AUDIO ERROR:", { err: err?.message || String(err), ms: Date.now() - started });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.startsWith("ar")
        ? "FixLens Brain تعذر عليه تحليل الصوت الآن. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain couldn’t analyze the audio right now. Please retry in a moment.",
      language: resolvedLang,
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  } finally {
    try { if (file?.path) fs.unlinkSync(file.path); } catch {}
  }
});

// ✅ Global Express error handler (last middleware)
app.use((err, req, res, next) => {
  console.error("GLOBAL_EXPRESS_ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(200).json({
    ok: false,
    error: "FixLens Brain error",
    details: err?.message || String(err),
  });
});

process.on("uncaughtException", (err) => console.error("UNCAUGHT_EXCEPTION:", err));
process.on("unhandledRejection", (reason) => console.error("UNHANDLED_REJECTION:", reason));

// ---------- Railway listen ----------
const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log("FixLens Brain running on port", PORT)
);

server.setTimeout(240000);
