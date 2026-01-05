// server.js
// FixLens Brain API — Server (Express) compatible with service.js

import express from "express";
import cors from "cors";
import { handleFixLensRequest } from "./service.js";

const app = express();

// ---- Config ----
const PORT = Number(process.env.PORT) || 8080;

// (اختياري) تقدر تحدد دومين تطبيقك للـCORS
// مثال: https://fixlens.ai
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsOptionsDelegate(req, cb) {
  // لو ما محدد origins، نسمح للجميع (أسهل للـstaging)
  if (ALLOWED_ORIGINS.length === 0) {
    return cb(null, { origin: true, credentials: true });
  }

  const origin = req.header("Origin");
  const ok = origin && ALLOWED_ORIGINS.includes(origin);
  cb(null, { origin: ok, credentials: true });
}

// ---- Middlewares ----
app.use(cors(corsOptionsDelegate));
app.use(express.json({ limit: "25mb" })); // مهم للصور/audio base64
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// ---- Routes ----
app.get("/", (req, res) => {
  res.json({ ok: true, name: "fixlens-brain-api", status: "running" });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "healthy",
    time: new Date().toISOString(),
  });
});

/**
 * POST /fixlens
 * Expected body:
 * {
 *   text: string,
 *   locale?: string,
 *   image_base64?: string,
 *   image_mime?: string,
 *   image_url?: string,
 *   audio_base64?: string,
 *   audio_filename?: string,
 *   audio_mime?: string
 * }
 */
app.post("/fixlens", async (req, res) => {
  try {
    const payload = req.body || {};
    const out = await handleFixLensRequest(payload);
    res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status) || 500;
    const message = String(err?.message || "Server error");

    // Logs مفيدة في Railway
    console.error("handleFixLensRequest error:", {
      status,
      message,
      request_id: err?.body?.request_id,
      openai_error: err?.body?.error,
      code: err?.body?.error?.code,
    });

    res.status(status).json({
      ok: false,
      error: message,
    });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
