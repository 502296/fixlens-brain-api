import dotenv from "dotenv";
dotenv.config();

import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { convertToWav16kMono } from "./lib/audio.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB
  },
});

// OpenAI client
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn("⚠️ Missing OPENAI_API_KEY");
}
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function pickModel() {
  // You can set ONE variable only: FIXLENS_MODEL
  // Or use OPENAI_MODEL_TEXT (fallback)
  return (
    process.env.FIXLENS_MODEL ||
    process.env.OPENAI_MODEL_TEXT ||
    "gpt-4o"
  );
}

function pickVisionModel() {
  return (
    process.env.OPENAI_MODEL_VISION ||
    process.env.FIXLENS_MODEL ||
    process.env.OPENAI_MODEL_TEXT ||
    "gpt-4o"
  );
}

function pickTranscribeModel() {
  // safest default for transcription
  return process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
}

/**
 * Expect request from Flutter like:
 * - JSON: { text, locale, history? }
 * - OR multipart/form-data including:
 *   - fields: text, locale
 *   - files: audio, image
 */
export async function handleFixLensRequest(req) {
  // Parse either JSON or multipart
  const contentType = String(req.headers["content-type"] || "");
  const isMultipart = contentType.includes("multipart/form-data");

  let text = "";
  let locale = "en";
  let imageFile = null;
  let audioFile = null;

  if (isMultipart) {
    const parsed = await new Promise((resolve, reject) => {
      upload.fields([
        { name: "image", maxCount: 1 },
        { name: "audio", maxCount: 1 },
      ])(req, null, (err) => {
        if (err) return reject(err);
        resolve({
          body: req.body || {},
          files: req.files || {},
        });
      });
    });

    text = safeStr(parsed.body?.text);
    locale = normalizeLocale(parsed.body?.locale || "en");

    imageFile = parsed.files?.image?.[0] || null;
    audioFile = parsed.files?.audio?.[0] || null;
  } else {
    text = safeStr(req.body?.text);
    locale = normalizeLocale(req.body?.locale || "en");
  }

  // If audio exists, transcribe first
  let transcribed = "";
  if (audioFile?.buffer?.length) {
    transcribed = await transcribeAudio(audioFile);
    // If user didn’t provide text, use transcription as text
    if (!text.trim()) text = transcribed;
    else {
      text = `${text}\n\n[User audio transcription]\n${transcribed}`;
    }
  }

  // Build response
  if (imageFile?.buffer?.length) {
    // Vision path
    const reply = await analyzeWithVision({
      text,
      locale,
      imageFile,
    });
    return { ok: true, reply, locale };
  }

  // Text-only path
  const reply = await analyzeWithText({ text, locale });
  return { ok: true, reply, locale };
}

async function transcribeAudio(audioFile) {
  try {
    // Convert anything into WAV 16k mono (solves "Invalid file format")
    const wavBuffer = await convertToWav16kMono(audioFile.buffer);

    const file = await toFile(wavBuffer, "audio.wav", {
      type: "audio/wav",
    });

    const model = pickTranscribeModel();
    const tr = await client.audio.transcriptions.create({
      model,
      file,
    });

    const text = safeStr(tr?.text);
    return text || "";
  } catch (err) {
    console.error("transcribeAudio error:", err?.message || err);
    // Don’t hard-fail the whole request
    return "";
  }
}

async function analyzeWithText({ text, locale }) {
  if (!text.trim()) {
    return locale === "ar"
      ? "اكتب المشكلة باختصار (السنة + الموديل + الأعراض + متى تحدث)، وأنا أساعدك خطوة بخطوة."
      : "Type the issue briefly (year + make/model + symptoms + when it happens) and I’ll guide you step by step.";
  }

  const model = pickModel();
  const system = buildDoctorSystemPrompt(locale);

  // ✅ Correct Responses API structure (fixes your earlier 400 about input_text)
  const r = await client.responses.create({
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
  });

  const out =
    r.output_text ||
    safeStr(r?.output?.[0]?.content?.[0]?.text) ||
    "";

  if (!out.trim()) {
    throw new Error("Empty model response");
  }
  return out;
}

async function analyzeWithVision({ text, locale, imageFile }) {
  const model = pickVisionModel();
  const system = buildDoctorSystemPrompt(locale);

  const b64 = imageFile.buffer.toString("base64");
  const mime = imageFile.mimetype || "image/jpeg";

  const userText = text?.trim()
    ? text
    : locale === "ar"
      ? "حلّل الصورة وشخّص المشكلة بشكل عملي."
      : "Analyze the photo and give a practical diagnosis.";

  const r = await client.responses.create({
    model,
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_image", image_url: `data:${mime};base64,${b64}` },
        ],
      },
    ],
  });

  const out = r.output_text || "";
  if (!out.trim()) {
    throw new Error("Empty vision response");
  }
  return out;
}
