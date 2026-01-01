// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// --------------------
// Middleware
// --------------------
app.use(cors());
app.use(express.json({ limit: "4mb" })); // زِدناها شوي حتى ما يصير fail مع meta

// --------------------
// Health check
// --------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

// --------------------
// Main Chat Routes
// --------------------
// ✅ route الأساسي
app.post("/chat", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("CHAT_ERROR:", err?.message || err);
    res.status(500).json({
      ok: false,
      error:
        "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

// ✅ alias مهم جدًا: كثير من التطبيقات تتوقع /api/diagnose
// هذا يمنع: Cannot POST /api/diagnose
app.post("/api/diagnose", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("DIAGNOSE_ERROR:", err?.message || err);
    res.status(500).json({
      ok: false,
      error:
        "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

// --------------------
// Optional: simple ping route for quick testing from browser
// --------------------
app.get("/api/ping", (_req, res) => {
  res.json({ ok: true, pong: true, ts: Date.now() });
});

// --------------------
// Optional: If you later add audio/image multipart endpoints,
// keep this template ready.
// --------------------
// app.post("/api/audio", upload.single("audio"), async (req, res) => { ... });
// app.post("/api/vision", upload.single("image"), async (req, res) => { ... });

// --------------------
// Not found handler (returns JSON بدل HTML 404)
// --------------------
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "Route not found. Use POST /chat or POST /api/diagnose",
  });
});

// --------------------
// Start server
// --------------------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
