// server.js (ESM)
import express from "express";
import cors from "cors";
import multer from "multer";
import { handleChat } from "./lib/service.js";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "3mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

/**
 * Unified handler:
 * Accepts:
 *  - POST /chat
 *  - POST /api/chat
 *  - POST /api/diagnose   (to match your Flutter screenshots)
 *
 * Body:
 * {
 *   "messages": [{ "role": "user|assistant|system", "content": "..." }],
 *   "meta": {
 *     "zip": "40218",
 *     "cityState": "Louisville, KY",
 *     "preferredStore": "AutoZone",
 *     "consent": { "accepted": true, "acceptedAt": "ISO" }
 *   }
 * }
 */
async function unified(req, res) {
  try {
    const payload = req.body || {};
    const result = await handleChat(payload);
    res.json(result);
  } catch (err) {
    console.error("FIXLENS_SERVER_ERROR:", err?.stack || err?.message || err);

    // Only "fallback" message when server is down / exception
    res.status(500).json({
      ok: false,
      error:
        "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
}

app.post("/chat", unified);
app.post("/api/chat", unified);
app.post("/api/diagnose", unified);

// (Optional) If later you add image/audio routes, keep them separate.
// app.post("/api/image", upload.single("image"), async (req, res) => { ... })

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`FixLens Brain running on port ${port}`));
