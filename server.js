// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat, handleSearchPing } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "6mb" })); // ارفعناها شوي

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

// Helper: always return JSON, never HTML
function sendError(res, err, fallbackMessage) {
  console.error("API_ERROR:", err?.message || err);
  res.status(500).json({
    ok: false,
    error: fallbackMessage || "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
  });
}

/**
 * MAIN CHAT ROUTE (existing)
 * POST /chat
 */
app.post("/chat", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    sendError(res, err, "FixLens Brain is busy or unavailable right now. Please try again in a moment.");
  }
});

/**
 * COMPAT ROUTES (so Flutter won't 404)
 * POST /api/diagnose  ✅
 * POST /api/chat      ✅
 */
app.post("/api/diagnose", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    sendError(res, err, "FixLens Brain is busy or unavailable right now. Please try again in a moment.");
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    sendError(res, err, "FixLens Brain is busy or unavailable right now. Please try again in a moment.");
  }
});

/**
 * SERPER PING (test route)
 * POST /api/search
 * body: { q: string, zip?: string, cityState?: string }
 */
app.post("/api/search", async (req, res) => {
  try {
    const { q, zip, cityState } = req.body || {};
    const result = await handleSearchPing({ q, zip, cityState });
    res.json(result);
  } catch (err) {
    sendError(res, err, "Search ping failed. Please try again.");
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
