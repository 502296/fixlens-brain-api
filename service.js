import dotenv from "dotenv";
dotenv.config();

import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { webSearch } from "./lib/search.js";
import { convertToWav16kMono } from "./lib/audio.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  return String(locale || "en").split("-")[0].toLowerCase();
}

function pickModel() {
  return process.env.FIXLENS_MODEL || "gpt-4.1";
}

function pickTranscribeModel() {
  return process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
}

export async function handleFixLensRequest(req) {
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

  // 🎤 Audio → text
  if (audioFile?.buffer) {
    const wav = await convertToWav16kMono(audioFile.buffer);
    const file = await toFile(wav, "audio.wav", { type: "audio/wav" });

    const tr = await client.audio.transcriptions.create({
      model: pickTranscribeModel(),
      file,
    });

    const audioText = safeStr(tr?.text);
    if (audioText) {
      text = text
        ? `${text}\n\n[User audio]\n${audioText}`
        : audioText;
    }
  }

  // Knowledge base
  const knowledge = buildKnowledgeSnippets(text);

  // Internal search (silent)
  const searchNotes = await webSearch(text);

  const system = buildDoctorSystemPrompt(locale);

  const messages = [
    { role: "system", content: system },
    ...(knowledge ? [{ role: "system", content: knowledge }] : []),
    ...(searchNotes ? [{ role: "system", content: searchNotes }] : []),
  ];

  // 🖼️ Vision
  if (imageFile?.buffer) {
    const b64 = imageFile.buffer.toString("base64");
    const mime = imageFile.mimetype || "image/jpeg";

    messages.push({
      role: "user",
      content: [
        { type: "input_text", text: text || "Analyze the image practically." },
        {
          type: "input_image",
          image_url: `data:${mime};base64,${b64}`,
        },
      ],
    });
  } else {
    messages.push({ role: "user", content: text });
  }

  const r = await client.responses.create({
    model: pickModel(),
    input: messages,
  });

  const reply =
    r.output_text ||
    r?.output?.[0]?.content?.[0]?.text ||
    "";

  if (!reply.trim()) {
    throw new Error("Empty model response");
  }

  return { ok: true, reply, locale };
}
