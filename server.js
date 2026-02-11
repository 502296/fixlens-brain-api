// server.js
import "dotenv/config";

import express from "express";
import cors from "cors";
import morgan from "morgan";
import { handleFixLensRequest } from "./service.js";

const app = express();

// =====================
// ✅ Core config
// =====================

// Railway/Prod friendly (so req.ip works behind proxy / load balancer)
app.set("trust proxy", 1);

// CORS (keep simple + safe defaults)
// If you want to lock it later: set ALLOWED_ORIGINS="https://yourdomain.com,https://another.com"
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser clients (curl/postman) and same-origin
      if (!origin) return cb(null, true);

      // if no allowlist provided -> allow all (good for early stage)
      if (allowedOrigins.length === 0) return cb(null, true);

      return allowedOrigins.includes(origin)
        ? cb(null, true)
        : cb(new Error("CORS_NOT_ALLOWED"));
    },
    credentials: true,
  })
);

app.use(morgan("combined"));
app.use(express.json({ limit: "25mb" }));

// =====================
// ✅ Routes
// =====================

// Health
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    time: new Date().toISOString(),
  });
});

// One handler used for multiple endpoints
const apiHandler = async (req, res, endpointName) => {
  try {
    const out = await handleFixLensRequest(req);
    return res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || `Unexpected error in ${endpointName}`;
    console.error(`${endpointName} error:`, {
      status,
      message,
      // Uncomment next line if you want full stack traces in logs:
      // stack: err?.stack,
    });
    return res.status(status).json({ ok: false, error: message, status });
  }
};

// ✅ Main endpoint
app.post("/api/fixlens", (req, res) => apiHandler(req, res, "/api/fixlens"));

// ✅ Alias endpoint (fix Flutter 404 WITHOUT touching Flutter)
app.post("/api/chat", (req, res) => apiHandler(req, res, "/api/chat"));

// =====================
// ✅ Not Found + Error handlers
// =====================

// Fallback 404
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path,
    method: req.method,
  });
});

// Central error handler (covers CORS_NOT_ALLOWED or other thrown errors)
app.use((err, req, res, next) => {
  const message = err?.message || "INTERNAL_ERROR";
  const status = message === "CORS_NOT_ALLOWED" ? 403 : 500;

  console.error("Unhandled error:", { status, message });
  res.status(status).json({ ok: false, error: message, status });
});

// =====================
// ✅ Start server
// =====================
const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});

// Graceful shutdown (Railway / container best practice)
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down...");
  server.close(() => process.exit(0));
});
