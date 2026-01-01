// server.js
import express from "express";
import cors from "cors";
import { textBrain } from "./service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "fixlens-brain" });
});

// Text-only endpoint
app.post("/v1/text", async (req, res) => {
  const started = Date.now();
  try {
    const { message, history = [], meta = {} } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "BAD_REQUEST", detail: "Missing 'message'." });
    }

    const out = await textBrain({ message, history, meta });
    return res.status(200).json({ ok: true, ms: Date.now() - started, ...out });
  } catch (err) {
    const msg = err?.message || "UNKNOWN_ERROR";
    // Never crash the server route. Return a safe error payload.
    return res.status(500).json({ ok: false, error: "BRAIN_ERROR", detail: msg });
  }
});

// Global fallback (Express error middleware)
app.use((err, req, res, next) => {
  const msg = err?.message || "UNHANDLED_ERROR";
  res.status(500).json({ ok: false, error: "UNHANDLED_ERROR", detail: msg });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FixLens Brain listening on ${port}`);
});
