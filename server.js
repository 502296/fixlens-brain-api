import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TEXT_MODEL = process.env.OPENAI_MODEL_TEXT || "gpt-4.1-mini";
const VISION_MODEL = process.env.OPENAI_MODEL_VISION || "gpt-4.1";
const AUDIO_MODEL = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe";

/* ------------------ HEALTH ------------------ */
app.get("/", (_, res) => {
  res.send("FixLens Brain API is running.");
});

/* ------------------ TEXT ------------------ */
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "NO_TEXT" });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: message }],
          },
        ],
      }),
    });

    const data = await r.json();
    const text =
      data.output_text ||
      data.output?.flatMap(o => o.content || [])
        .filter(c => c.type === "output_text")
        .map(c => c.text)
        .join("\n");

    res.json({ ok: true, reply: text });
  } catch (e) {
    res.status(502).json({ ok: false, error: "OPENAI_ERROR", detail: e.message });
  }
});

/* ------------------ IMAGE ------------------ */
app.post("/api/image-diagnose", async (req, res) => {
  try {
    const { imageBase64, question } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ ok: false, error: "NO_IMAGE" });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: question || "Diagnose this image." },
              {
                type: "input_image",
                image_base64: imageBase64,
              },
            ],
          },
        ],
      }),
    });

    const data = await r.json();
    const text =
      data.output_text ||
      data.output?.flatMap(o => o.content || [])
        .filter(c => c.type === "output_text")
        .map(c => c.text)
        .join("\n");

    res.json({ ok: true, reply: text });
  } catch (e) {
    res.status(502).json({ ok: false, error: "VISION_ERROR", detail: e.message });
  }
});

/* ------------------ AUDIO ------------------ */
app.post("/api/audio-diagnose", async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ ok: false, error: "NO_AUDIO" });
    }

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: Buffer.from(audioBase64, "base64"),
    });

    const data = await r.json();
    res.json({ ok: true, text: data.text });
  } catch (e) {
    res.status(502).json({ ok: false, error: "AUDIO_ERROR", detail: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
