// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "os";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import {
  diagnoseText,
  diagnoseImage,
  diagnoseAudio,
  getDataHealth,
} from "./lib/service.js";

const app = express();

// ============================
// ✅ Config
// ============================
const PORT = Number(process.env.PORT || 8080);

// Request body limits
app.use(express.json({ limit: process.env.JSON_LIMIT || "12mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_LIMIT || "12mb" }));

// ✅ CORS (important for iOS + webviews + preflight)
const corsOrigin = process.env.CORS_ORIGIN || "*";
app.use(
  cors({
    origin: corsOrigin === "*" ? true : corsOrigin.split(",").map((s) => s.trim()),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-FixLens-Lang"],
    credentials: false,
    maxAge: 86400,
  })
);
app.options("*", cors());

// ✅ Safety: always have a server-side timeout for responses
app.use((req, res, next) => {
  res.setTimeout(240000);
  next();
});

// Simple request id for logs
function rid() {
  return crypto.randomBytes(6).toString("hex");
}

// ============================
// ✅ Multer (temp files)
// ============================
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

// ============================
// Language helpers
// ============================
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

// ============================
// ✅ History parser (handles JSON string from multipart)
// ============================
function parseHistoryAny(history) {
  try {
    if (!history) return [];
    if (Array.isArray(history)) return history;

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

// ============================
// Timeout wrapper (prevents hanging)
// ============================
function withTimeout(promise, ms, label = "UPSTREAM_TIMEOUT") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

// ============================
// Health + basic routes
// ============================
app.get("/", (req, res) => res.status(200).send("FixLens Brain API is running ✅"));

app.get("/health", (req, res) =>
  res.status(200).json({
    ok: true,
    service: "fixlens-brain",
    uptimeSec: Math.floor(process.uptime()),
  })
);

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

// ============================
// ---------- TEXT ----------
// ============================
app.post("/api/diagnose", async (req, res) => {
  const id = rid();
  const started = Date.now();

  try {
    const { message, preferredLanguage, vehicleInfo, mode, history } = req.body || {};
    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

    // ✅ longer timeouts for GPT-5.1 deep replies
    const out = await withTimeout(
      diagnoseText({
        message,
        preferredLanguage: resolvedLang,
        vehicleInfo,
        history: parseHistoryAny(history),
        mode: mode || "doctor",
      }),
      Number(process.env.TEXT_TIMEOUT_MS || 120000),
      "TEXT_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);

    console.log(`[${id}] TEXT ok ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[${id}] TEXT ERROR`, {
      err: err?.message || String(err),
      ms: Date.now() - started,
    });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.toLowerCase().startsWith("ar")
        ? "FixLens Brain مشغول الآن أو لم يستطع الرد. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
      language: resolvedLang,
      error: "Text diagnosis failed",
      details: err?.message || String(err),
    });
  }
});

// ============================
// ---------- IMAGE ----------
// ============================
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  const id = rid();
  const started = Date.now();
  const file = req.file;

  try {
    const { message, preferredLanguage, vehicleInfo, mode, history } = req.body || {};
    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

    if (!file?.path) {
      setContentLanguage(res, resolvedLang);
      return res.status(200).json({
        ok: false,
        error: "Image diagnosis failed",
        details: "No image received",
        language: resolvedLang,
      });
    }

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
      }),
      Number(process.env.IMAGE_TIMEOUT_MS || 120000),
      "IMAGE_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);

    console.log(`[${id}] IMAGE ok ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[${id}] IMAGE ERROR`, {
      err: err?.message || String(err),
      ms: Date.now() - started,
    });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.toLowerCase().startsWith("ar")
        ? "FixLens Brain تعذر عليه تحليل الصورة الآن. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain couldn’t analyze the image right now. Please retry in a moment.",
      language: resolvedLang,
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  } finally {
    try {
      if (file?.path) fs.unlinkSync(file.path);
    } catch {}
  }
});

// ============================
// ---------- AUDIO ----------
// ============================
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  const id = rid();
  const started = Date.now();
  const file = req.file;

  try {
    const { message, preferredLanguage, vehicleInfo, mode, history } = req.body || {};
    const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

    if (!file?.path) {
      setContentLanguage(res, resolvedLang);
      return res.status(200).json({
        ok: false,
        error: "Audio diagnosis failed",
        details: "No audio file received",
        language: resolvedLang,
      });
    }

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
      }),
      Number(process.env.AUDIO_TIMEOUT_MS || 180000),
      "AUDIO_UPSTREAM_TIMEOUT"
    );

    setContentLanguage(res, out?.language || resolvedLang);
    res.status(200).json(out);

    console.log(`[${id}] AUDIO ok ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[${id}] AUDIO ERROR`, {
      err: err?.message || String(err),
      ms: Date.now() - started,
    });

    const resolvedLang = resolvePreferredLanguage(req, req?.body?.preferredLanguage);
    setContentLanguage(res, resolvedLang);

    res.status(200).json({
      ok: false,
      reply: resolvedLang.toLowerCase().startsWith("ar")
        ? "FixLens Brain تعذر عليه تحليل الصوت الآن. جرّب مرة ثانية بعد دقيقة."
        : "FixLens Brain couldn’t analyze the audio right now. Please retry in a moment.",
      language: resolvedLang,
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  } finally {
    try {
      if (file?.path) fs.unlinkSync(file.path);
    } catch {}
  }
});

// ============================
// ✅ Global Express error handler
// ============================
app.use((err, req, res, next) => {
  console.error("GLOBAL_EXPRESS_ERROR:", err);
  if (res.headersSent) return next(err);
  res.status(200).json({
    ok: false,
    error: "FixLens Brain error",
    details: err?.message || String(err),
  });
});

// ============================
// ✅ Railway listen + graceful shutdown
// ============================
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log("FixLens Brain running on port", PORT)
);

server.setTimeout(240000);

// Graceful shutdown (Railway sends SIGTERM on redeploy)
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Closing server...");
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
});
process.on("SIGINT", () => {
  console.log("SIGINT received. Closing server...");
  server.close(() => process.exit(0));
});
