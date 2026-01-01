// server.js
import express from "express";
import cors from "cors";
import { handleText } from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Health check
app.get("/", (req, res) => {
  res.json({ ok: true, service: "FixLens Brain API" });
});

// MAIN AI ENDPOINT
app.post("/api/text", async (req, res) => {
  try {
    const {
      text,
      zip = null,
      outputLanguage = null,
      showSources = false,
    } = req.body || {};

    if (!text || typeof text !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid 'text' field",
      });
    }

    const result = await handleText({
      text,
      zip,
      outputLanguage,
      showSources,
    });

    // Always return JSON
    return res.json(result);
  } catch (err) {
    console.error("FixLens Brain crash:", err);

    return res.status(500).json({
      ok: false,
      error: "FixLens Brain is busy or unavailable right now. Please try again.",
    });
  }
});

// 404 fallback (important to avoid HTML errors)
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint not found",
  });
});

// Server start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
