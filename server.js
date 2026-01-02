import express from "express";
import cors from "cors";
import { diagnoseText } from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/diagnose", async (req, res) => {
  try {
    const { text, language = "en" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "NO_TEXT" });
    }

    const result = await diagnoseText({ text, language });

    res.json({ ok: true, result });
  } catch (err) {
    console.error("Diagnose error:", err);
    res.status(500).json({
      error: "DIAGNOSE_FAILED",
      message: err.message,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("FixLens Brain API running on port", PORT);
});
