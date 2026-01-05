import dotenv from "dotenv";
dotenv.config();

import multer from "multer";
import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { convertToWav16kMono } from "./lib/audio.js";
import { toFile } from "openai/uploads";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function safeStr(x) { return typeof x === "string" ? x : ""; }
function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  return (l.split("-")[0] || "en").toLowerCase();
}

function pickModel() {
  // ✅ stable default
  return process.env.FIXLENS_MODEL || "gpt-4o";
}
function pickVisionModel() {
  return process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
}
function pickTranscribeModel() {
  return process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
}

// -------- Main handler --------
export async function handleFixLensRequest(req) {
  const ct = String(req.headers["content-type"] || "");
  const isMultipart = ct.includes("multipart/form-data");

  let text = "";
  let locale = "en";
  let imageFile = null;
  let audioFile = null;

  if (isMultipart) {
    const parsed = await new Promise((resolve, reject) => {
      upload.fields([
        { name: "image", maxCount: 1 },
        { name: "audio", maxCount: 1 }
      ])(req, null, (err) => {
        if (err) return reject(err);
        resolve({ body: req.body || {}, files: req.files || {} });
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

  // 1) Audio → transcription (best effort)
  let transcription = "";
  if (audioFile?.buffer?.length) {
    transcription = await transcribeAudioBestEffort(audioFile);
    if (transcription.trim()) {
      text = text.trim()
        ? `${text}\n\n[Audio transcription]\n${transcription}`
        : transcription;
    }
  }

  // 2) Build prompts
  const system = buildDoctorSystemPrompt(locale);

  // 3) Image path
  if (imageFile?.buffer?.length) {
    const reply = await analyzeWithVision({ system, text, locale, imageFile });
    return { ok: true, reply, locale, used: { image: true, audio: !!transcription } };
  }

  // 4) Text path
  const reply = await analyzeWithText({ system, text, locale });
  return { ok: true, reply, locale, used: { image: false, audio: !!transcription } };
}

// -------- Text-only --------
async function analyzeWithText({ system, text, locale }) {
  const t = text?.trim();
  if (!t) {
    return locale === "ar"
      ? "اكتب المشكلة باختصار: سنة السيارة + الموديل + الأعراض + متى تظهر."
      : "Type the issue briefly: year + make/model + symptoms + when it happens.";
  }

  const model = pickModel();

  const r = await client.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      { role: "user", content: t }
    ]
  });

  const out = r?.choices?.[0]?.message?.content || "";
  if (!out.trim()) throw new Error("Empty model response (text)");
  return out;
}

// -------- Vision --------
async function analyzeWithVision({ system, text, locale, imageFile }) {
  const model = pickVisionModel();

  const userText =
    text?.trim() ||
    (locale === "ar"
      ? "حلّل الصورة وشخّص المشكلة بشكل عملي."
      : "Analyze the photo and give a practical diagnosis.");

  const b64 = imageFile.buffer.toString("base64");
  const mime = imageFile.mimetype || "image/jpeg";

  const r = await client.chat.completions.create({
    model,
    temperature: 0.3,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
        ]
      }
    ]
  });

  const out = r?.choices?.[0]?.message?.content || "";
  if (!out.trim()) throw new Error("Empty model response (vision)");
  return out;
}

// -------- Audio transcription (best effort) --------
async function transcribeAudioBestEffort(audioFile) {
  try {
    // Convert any input to WAV 16k mono to satisfy supported formats.
    const wavBuffer = await convertToWav16kMono(audioFile.buffer);

    const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });

    const model = pickTranscribeModel();
    const tr = await client.audio.transcriptions.create({
      model,
      file
    });

    return safeStr(tr?.text);
  } catch (err) {
    console.error("Audio transcription failed (continuing):", err?.message || err);
    return ""; // don't fail whole request
  }
}
