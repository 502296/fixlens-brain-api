import express from "express";
import cors from "cors";
import { textBrain } from "./service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Root check
app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running.");
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, service: "fixlens-brain" });
});

async function handler(req, res) {
  try {
    const { message, history = [], meta = {} } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({
        ok: false,
        error: "BAD_REQUEST",
        detail: "Missing message"
      });
    }

    const out = await textBrain({ message, history, meta });
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "BRAIN_ERROR",
      detail: err?.message || "Unknown error"
    });
  }
}

// Support both endpoints (Flutter-safe)
app.post("/v1/text", handler);
app.post("/text", handler);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`FixLens Brain listening on port ${port}`);
});
