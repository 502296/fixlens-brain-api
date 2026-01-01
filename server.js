// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Railway/Cloud friendly
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

/**
 * Compat routes:
 * - POST /chat
 * - POST /api/diagnose   (older Flutter calls)
 * - POST /diagnose
 *
 * We accept any of these shapes:
 * 1) { messages: [{role, content}], meta?: {...} }
 * 2) { message: "text", meta?: {...} }
 * 3) { text: "text", zip?: "40218", cityState?: "Louisville, KY" }
 */
async function unifiedHandler(req, res) {
  try {
    const body = req.body || {};
    const result = await handleChat(body);
    res.json(result);
  } catch (err) {
    console.error("API_ERROR:", err?.message || err);

    // ✅ ONLY fallback message allowed (server/OpenAI down)
    res.status(500).json({
      ok: false,
      error:
        "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
}

app.post("/chat", unifiedHandler);
app.post("/api/diagnose", unifiedHandler);
app.post("/diagnose", unifiedHandler);

// (Optional) future: audio/image endpoints
app.post("/upload", upload.single("file"), async (_req, res) => {
  res.status(501).json({ ok: false, error: "Not implemented" });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
