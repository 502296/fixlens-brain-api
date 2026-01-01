// server.js
import express from "express";
import cors from "cors";
import crypto from "crypto";

import { handleDiagnose } from "./lib/service.js";

const app = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "2mb" }));

// Request id (helpful for debugging)
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader("x-request-id", req.id);
  next();
});

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "FixLens Brain API" });
});

// Main endpoint (keep it consistent with Flutter)
app.post("/api/diagnose", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await handleDiagnose(body, { requestId: req.id });
    res.json(result);
  } catch (err) {
    // Only here we allow a generic fallback (server down / runtime error)
    res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

// 404 JSON (so Flutter doesn't receive HTML)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "ENDPOINT_NOT_FOUND", path: req.path });
});

// Start
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FixLens Brain API running on :${port}`);
});
