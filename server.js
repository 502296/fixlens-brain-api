// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

/**
 * POST /chat
 * body: {
 *   messages: [{ role: "user"|"assistant"|"system", content: string }],
 *   meta?: {
 *     zip?: string,
 *     cityState?: string,
 *     preferredStore?: string,
 *     consent?: { accepted?: boolean, acceptedAt?: string }
 *   }
 * }
 */
app.post("/chat", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("CHAT_ERROR:", err?.message || err);
    res.status(500).json({
      ok: false,
      reply: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

/**
 * ✅ Alias route for older Flutter builds:
 * Some clients still call POST /api/diagnose
 * We route it to the same handler to avoid 404
 */
app.post("/api/diagnose", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("DIAGNOSE_ERROR:", err?.message || err);
    res.status(500).json({
      ok: false,
      reply: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

// Optional: accept multipart image/audio later (you can keep it ready)
app.post("/api/ping-upload", upload.single("file"), (req, res) => {
  res.json({ ok: true, received: !!req.file, size: req.file?.size || 0 });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
