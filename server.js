// server.js
import express from "express";
import cors from "cors";
import { handleChat } from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

app.post("/chat", async (req, res) => {
  try {
    const result = await handleChat(req.body || {});
    res.json(result);
  } catch (err) {
    console.error("FIXLENS_FATAL:", err);
    res.status(500).json({
      ok: false,
      reply:
        "FixLens Brain is temporarily unavailable. Please try again in a moment.",
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain running on port ${port}`);
});
