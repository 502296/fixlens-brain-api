// server.js
import express from "express";
import cors from "cors";
import { textBrain } from "./service.js";

const app = express();

// If you want strict CORS later, we can lock it down.
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.status(200).send("FixLens Brain API is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// ✅ Main endpoint for Flutter text diagnosis
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message, history, meta } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "MISSING_MESSAGE" });
    }

    const out = await textBrain({ message, history: history || [], meta: meta || {} });

    return res.status(200).json({
      ok: true,
      reply: out.reply,
      debug: out.debug || {},
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      detail: String(e?.message || e),
    });
  }
});

// Railway uses PORT
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`FixLens Brain API listening on port ${port}`);
});
