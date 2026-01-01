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

// helper to unify all endpoints
async function runChat(req, res) {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("CHAT_ERROR:", err?.stack || err?.message || err);
    res.status(500).json({
      ok: false,
      reply: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
}

// main endpoints
app.post("/chat", runChat);
app.post("/api/chat", runChat);

// aliases for old/other client versions
app.post("/diagnose", runChat);
app.post("/api/diagnose", runChat);

// if you later add image/audio multipart endpoints, keep these:
app.post("/api/upload", upload.single("file"), async (req, res) => {
  res.status(501).json({ ok: false, reply: "Upload endpoint not enabled in this build." });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
