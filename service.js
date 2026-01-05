import dotenv from "dotenv";
dotenv.config();

import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { convertToWav16kMono } from "./lib/audio.js";
import { webSearch } from "./lib/search.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function looksArabic(s = "") {
  return /[\u0600-\u06FF]/.test(String(s));
}

function normalizeLocale(locale = "en", text = "") {
  const raw = String(locale || "").trim();
  // If the text is Arabic, force ar (fix Spanish/locale bugs)
  if (looksArabic(text)) return "ar";
  if (!raw) return "en";
  return raw.split("-")[0].toLowerCase();
}

function preferredTextModel() {
  // Put what you want here. We’ll fallback if not available.
  return process.env.FIXLENS_MODEL || process.env.OPENAI_MODEL_TEXT || "gpt-5-mini";
}

function preferredVisionModel() {
  return process.env.OPENAI_MODEL_VISION || process.env.FIXLENS_MODEL || process.env.OPENAI_MODEL_TEXT || "gpt-4o";
}

function transcribeModel() {
  return process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
}

function shouldUseSearch(text = "") {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("near me") ||
    t.includes("nearest") ||
    t.includes("price") ||
    t.includes("where can i") ||
    t.includes("shop") ||
    t.includes("workshop") ||
    t.includes("ورشة") ||
    t.includes("قريبة") ||
    t.includes("وين") ||
    t.includes("سعر") ||
    t.includes("أفضل مكان")
  );
}

async function tryResponses(payload, fallbackModel) {
  try {
    return await client.responses.create(payload);
  } catch (err) {
    const msg = String(err?.message || "");
    const status = Number(err?.status || err?.statusCode || 0);

    // If model unavailable / invalid → fallback
    if (status === 404 || msg.toLowerCase().includes("model") || msg.toLowerCase().includes("not found")) {
      const p2 = { ...payload, model: fallbackModel };
      return await client.responses.create(p2);
    }
    throw err;
  }
}

/**
 * Supports:
 * 1) JSON: { text, locale, image_base64, image_mime, audio_base64, audio_mime }
 * 2) multipart/form-data: fields text, locale; files image, audio
 */
export async function handleFixLensRequest(req) {
  const contentType = String(req.headers["content-type"] || "");
  const isMultipart = contentType.includes("multipart/form-data");

  let text = "";
  let locale = "en";
  let imageFile = null;
  let audioFile = null;

  // JSON base64 support
  let imageBase64 = "";
  let imageMime = "";
  let audioBase64 = "";
  let audioMime = "";

  if (isMultipart) {
    const parsed = await new Promise((resolve, reject) => {
      upload.fields([
        { name: "image", maxCount: 1 },
        { name: "audio", maxCount: 1 },
      ])(req, null, (err) => {
        if (err) return reject(err);
        resolve({ body: req.body || {}, files: req.files || {} });
      });
    });

    text = safeStr(parsed.body?.text);
    locale = normalizeLocale(parsed.body?.locale || "en", text);

    imageFile = parsed.files?.image?.[0] || null;
    audioFile = parsed.files?.audio?.[0] || null;
  } else {
    text = safeStr(req.body?.text);
    locale = normalizeLocale(req.body?.locale || "en", text);

    imageBase64 = safeStr(req.body?.image_base64);
    imageMime = safeStr(req.body?.image_mime) || "image/jpeg";

    audioBase64 = safeStr(req.body?.audio_base64);
    audioMime = safeStr(req.body?.audio_mime) || "audio/mpeg";
  }

  // If audio base64 exists (JSON), convert to multer-like file
  if (!audioFile && audioBase64) {
    try {
      const buf = Buffer.from(audioBase64, "base64");
      audioFile = { buffer: buf, mimetype: audioMime, originalname: "audio" };
    } catch {}
  }

  // If image base64 exists (JSON), convert to multer-like file
  if (!imageFile && imageBase64) {
    try {
      const buf = Buffer.from(imageBase64, "base64");
      imageFile = { buffer: buf, mimetype: imageMime, originalname: "image" };
    } catch {}
  }

  // If audio exists, transcribe first
  let transcribed = "";
  if (audioFile?.buffer?.length) {
    transcribed = await transcribeAudio(audioFile);
    if (transcribed.trim()) {
      if (!text.trim()) text = transcribed;
      else text = `${text}\n\n[Audio transcription]\n${transcribed}`;
    }
  }

  // Knowledge snippets (local)
  const kb = buildKnowledgeSnippets(text);

  // Web search (optional)
  let searchBlock = "";
  let usedSearch = false;
  if (shouldUseSearch(text)) {
    const hl = locale === "ar" ? "ar" : "en";
    const s = await webSearch(text, { gl: "us", hl, num: 5 });
    if (s.ok && s.results.length) {
      usedSearch = true;
      const lines = s.results
        .slice(0, 3)
        .map((r, i) => `- ${i + 1}) ${r.title} — ${r.snippet}`) // no long quotes
        .join("\n");
      searchBlock = `\n\n[Web search results]\n${lines}\n`;
    }
  }

  // Compose final user text for model
  const userText = buildUserText({ text, locale, kb, searchBlock });

  // Vision path
  if (imageFile?.buffer?.length) {
    const reply = await analyzeWithVision({ userText, locale, imageFile });
    return {
      ok: true,
      reply,
      locale,
      meta: { usedVision: true, usedAudio: !!transcribed, usedSearch },
    };
  }

  // Text-only
  const reply = await analyzeWithText({ userText, locale });
  return {
    ok: true,
    reply,
    locale,
    meta: { usedVision: false, usedAudio: !!transcribed, usedSearch },
  };
}

function buildUserText({ text, locale, kb, searchBlock }) {
  if (!String(text || "").trim()) {
    return locale === "ar"
      ? "اكتب المشكلة باختصار (السنة + الموديل + الأعراض + متى تحدث)، وأنا أساعدك خطوة بخطوة."
      : "Type the issue briefly (year + make/model + symptoms + when it happens) and I’ll guide you step by step.";
  }

  let out = text.trim();

  if (kb) out += `\n\n[Internal knowledge]\n${kb}`;
  if (searchBlock) out += searchBlock;

  return out;
}

async function transcribeAudio(audioFile) {
  try {
    const wavBuffer = await convertToWav16kMono(audioFile.buffer);

    const file = await toFile(wavBuffer, "audio.wav", { type: "audio/wav" });
    const tr = await client.audio.transcriptions.create({
      model: transcribeModel(),
      file,
    });

    return safeStr(tr?.text) || "";
  } catch (err) {
    console.error("transcribeAudio error:", err?.message || err);
    return "";
  }
}

async function analyzeWithText({ userText, locale }) {
  const system = buildDoctorSystemPrompt(locale);

  const model = preferredTextModel();
  const fallback = "gpt-4o"; // rock-solid fallback

  const r = await tryResponses(
    {
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    },
    fallback
  );

  const out = r.output_text || safeStr(r?.output?.[0]?.content?.[0]?.text) || "";
  if (!out.trim()) throw new Error("Empty model response");
  return out;
}

async function analyzeWithVision({ userText, locale, imageFile }) {
  const system = buildDoctorSystemPrompt(locale);

  const model = preferredVisionModel();
  const fallback = "gpt-4o"; // best fallback for vision too

  const b64 = imageFile.buffer.toString("base64");
  const mime = imageFile.mimetype || "image/jpeg";

  const r = await tryResponses(
    {
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
    },
    fallback
  );

  const out = r.output_text || "";
  if (!out.trim()) throw new Error("Empty vision response");
  return out;
}
