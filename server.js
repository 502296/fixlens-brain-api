// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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
      error: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
