// server.js
import express from "express";
import cors from "cors";
import { handleDiagnose } from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

// ✅ واحد فقط: Flutter يضرب هذا
app.post("/api/diagnose", async (req, res) => {
  try {
    const out = await handleDiagnose(req.body || {});
    res.json(out);
  } catch (err) {
    console.error("DIAGNOSE_ERROR:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`FixLens Brain running on port ${port}`));
