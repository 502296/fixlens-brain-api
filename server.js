import express from "express";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
app.use(express.json({ limit: "20mb" }));

// =====================
// OpenAI
// =====================
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

const openai = new OpenAI({ apiKey });

const MODEL_TEXT = "gpt-4o-mini";
const MODEL_VISION = "gpt-4o-mini";
const MODEL_TRANSCRIBE = "whisper-1";

// =====================
// Helpers
// =====================
function normalizeBase64(data) {
  const m = String(data).match(/^data:.*;base64,(.*)$/);
  return m ? m[1] : data;
}

function detectImageMime(base64) {
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("iVBOR")) return "image/png";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

function buildImageDataUrl(base64) {
  const raw = normalizeBase64(base64);
  const mime = detectImageMime(raw);
  return `data:${mime};base64,${raw}`;
}

// =====================
// Health
// =====================
app.get("/", (_, res) => {
  res.send("FixLens Brain API is running ✅");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

// =====================
// TEXT
// =====================
app.post("/api/diagnose", async (req, res) => {
  try {
    const { message } = req.body;

    const ai = await openai.responses.create({
      model: MODEL_TEXT,
      input: message,
    });

    res.json({ reply: ai.output_text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Text diagnosis failed" });
  }
});

// =====================
// IMAGE
// =====================
app.post("/api/image-diagnose", async (req, res) => {
  try {
    const { message, imageBase64 } = req.body;
    if (!imageBase64) throw new Error("No image");

    const imageUrl = buildImageDataUrl(imageBase64);

    const ai = await openai.responses.create({
      model: MODEL_VISION,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: message || "Analyze this image" },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ],
    });

    res.json({ reply: ai.output_text });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Image diagnosis failed",
      details: e.message,
    });
  }
});

// =====================
// AUDIO
// =====================
app.post("/api/audio-diagnose", async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) throw new Error("No audio");

    const raw = normalizeBase64(audioBase64);
    const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.webm`);
    fs.writeFileSync(tmpPath, Buffer.from(raw, "base64"));

    const transcript = await openai.audio.transcriptions.create({
      model: MODEL_TRANSCRIBE,
      file: fs.createReadStream(tmpPath),
    });

    fs.unlinkSync(tmpPath);

    const ai = await openai.responses.create({
      model: MODEL_TEXT,
      input: transcript.text,
    });

    res.json({
      transcript: transcript.text,
      reply: ai.output_text,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message,
    });
  }
});

// =====================
// Listen (Railway)
// =====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});
