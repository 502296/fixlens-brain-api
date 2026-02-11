import "dotenv/config";

import express from "express";
import cors from "cors";
import morgan from "morgan";
import { handleFixLensRequest } from "./service.js";

const app = express();

// Railway/Prod friendly (so req.ip works behind proxy / load balancer)
app.set("trust proxy", 1);

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
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

// Health
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "fixlens-brain-api",
    time: new Date().toISOString(),
  });
});

const apiHandler = async (req, res, endpointName) => {
  try {
    const out = await handleFixLensRequest(req);
    return res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || `Unexpected error in ${endpointName}`;
    console.error(`${endpointName} error:`, { status, message });
    return res.status(status).json({ ok: false, error: message, status });
  }
};

app.post("/api/fixlens", (req, res) => apiHandler(req, res, "/api/fixlens"));
app.post("/api/chat", (req, res) => apiHandler(req, res, "/api/chat"));

// 404
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path,
    method: req.method,
  });
});

// Error handler
app.use((err, req, res, next) => {
  const message = err?.message || "INTERNAL_ERROR";
  const status = message === "CORS_NOT_ALLOWED" ? 403 : 500;
  console.error("Unhandled error:", { status, message });
  res.status(status).json({ ok: false, error: message, status });
});

const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down...");
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down...");
  server.close(() => process.exit(0));
});
