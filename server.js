import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import multer from "multer";
import fs from "fs";

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-5.1";
const MODEL_VISION = process.env.OPENAI_MODEL_VISION || "gpt-5.1";
const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-transcribe";

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (_, res) => {
  res.json({ ok: true, status: "FixLens Brain online" });
});

/* =========================
   TEXT DIAGNOSIS
========================= */
app.post("/api/diagnose", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ ok: false, error: "NO_TEXT" });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_TEXT,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text }
            ],
          },
        ],
      }),
    });

    const data = await r.json();

    const output =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "No response generated.";

    res.json({ ok: true, text: output });
  } catch (err) {
    console.error("TEXT ERROR:", err);
    res.status(500).json({ ok: false, error: "TEXT_FAILED" });
  }
});

/* =========================
   IMAGE DIAGNOSIS
========================= */
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_VISION,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_image",
                image_base64: base64Image,
              },
              {
                type: "input_text",
                text: "Analyze this car issue like a professional mechanic.",
              },
            ],
          },
        ],
      }),
    });

    const data = await r.json();

    const output =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "No image analysis generated.";

    res.json({ ok: true, text: output });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({ ok: false, error: "IMAGE_FAILED" });
  }
});

/* =========================
   AUDIO DIAGNOSIS
========================= */
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
  try {
    const audioStream = fs.createReadStream(req.file.path);

    const formData = new FormData();
    formData.append("file", audioStream);
    formData.append("model", MODEL_TRANSCRIBE);

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const data = await r.json();

    res.json({ ok: true, text: data.text });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res.status(500).json({ ok: false, error: "AUDIO_FAILED" });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FixLens Brain API listening on port ${PORT}`);
});
