// server.js
import express from "express";
import cors from "cors";
import { textBrain } from "./service.js";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Health / Root ----------
app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

// ---------- Shared handler ----------
async function handler(req, res) {
  try {
    const { message, history = [], meta = {} } = req.body || {};

    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        error: "INVALID_INPUT",
        message: "Missing or invalid `message` field",
      });
    }

    const result = await textBrain({ message, history, meta });

    return res.status(200).json({
      ok: true,
      reply: result.reply,
      debug: result.debug || {},
    });
  } catch (err) {
    console.error("FixLens Brain error:", err);
    return res.status(500).json({
      ok: false,
      error: "BRAIN_ERROR",
      message: "FixLens Brain failed to respond",
    });
  }
}

// ---------- API Routes (ALL supported) ----------

// Main API
app.post("/v1/text", handler);
app.post("/text", handler);

// ✅ Flutter endpoint (IMPORTANT)
app.post("/api/diagnose", handler);

// Optional aliases (safe, future-proof)
app.post("/diagnose", handler);
app.post("/api/text", handler);

// ---------- 404 fallback ----------
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path,
  });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
