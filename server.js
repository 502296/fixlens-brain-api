import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";

const app = express();
app.use(cors());
app.use(express.json());

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  throw new Error("Missing OPENAI_API_KEY");
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "FixLens Brain Online" });
});

/* =========================
   MAIN DIAGNOSE ROUTE
========================= */
app.post("/api/diagnose", async (req, res) => {
  try {
    const {
      message,
      outputLanguage = "en",
      zip = null,
      showSources = false
    } = req.body;

    if (!message) {
      return res.status(400).json({ ok: false, error: "Missing message" });
    }

    /* -------- Intent Detection -------- */
    const lower = message.toLowerCase();

    const wantsPrice =
      lower.includes("price") ||
      lower.includes("cost") ||
      lower.includes("كم") ||
      lower.includes("السعر");

    const wantsNearby =
      lower.includes("near") ||
      lower.includes("قريب") ||
      lower.includes("zip");

    const needsSearch = wantsPrice || wantsNearby;

    const needsZip = needsSearch && !zip;

    /* -------- Build Prompt -------- */
    const systemPrompt = buildDoctorSystemPrompt({ outputLanguage });

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ];

    const aiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-5.1",
          temperature: 0.35,
          messages
        })
      }
    );

    const data = await aiResponse.json();
    const reply = data.choices?.[0]?.message?.content || "";

    return res.json({
      ok: true,
      language: outputLanguage,
      reply,
      needsSearch,
      needsZip,
      needsConsent: false,
      searchQuery: needsSearch ? message : null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: "FixLens Brain internal error"
    });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🧠 FixLens Brain running on port ${PORT}`)
);
