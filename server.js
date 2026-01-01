// server.js
import express from "express";
import cors from "cors";
import { textBrain } from "./service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "fixlens-brain-api", ts: Date.now() });
});

app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, history, meta } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "MISSING_MESSAGE" });
    }

    const out = await textBrain({ message, history: history || [], meta: meta || {} });
    return res.status(200).json({ ok: true, reply: out.reply, debug: out.debug || null });
  } catch (err) {
    console.error("DIAGNOSE_FATAL:", err?.message || err, err?.stack || "");
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
});

// Express fallback (so you see clear route errors)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "NOT_FOUND", path: req.path });
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`FixLens Brain API listening on port ${port}`);
});
