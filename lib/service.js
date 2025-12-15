// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import { findRelevantIssues } from "./autoKnowledge.js";

// ============================
// OpenAI Client
// ============================
const apiKey =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI_TOKEN ||
  "";

if (!apiKey || !apiKey.trim()) {
  throw new Error("Missing OPENAI_API_KEY in Railway Variables.");
}

const openai = new OpenAI({ apiKey });

// ============================
// Models
// ============================
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_VISION = process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";

// ============================
// Helpers
// ============================
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  if (/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(t)) return "cjk";
  return "en";
}

function extractReplyFromResponse(resp) {
  if (resp?.output_text) return resp.output_text;

  const out = resp?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      if (item?.content && Array.isArray(item.content)) {
        for (const c of item.content) {
          if ((c?.type === "output_text" || c?.type === "text") && c?.text) parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }
  return "";
}

function buildSystemInstruction(lang) {
  return `
You are FixLens Auto — a world-class vehicle diagnostic AI.
Always respond in the user's language (${lang || "auto"}).
Be concise but professional.

Output format MUST be:

Quick Summary:
- ...

Most Likely Causes (ranked):
1) ...
2) ...
3) ...

Recommended Next Steps:
- ...

Safety Warnings:
- ...

Ask 3 smart follow-up questions at the end.
Avoid guessing exact part replacement; give probabilities and checks.
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  // مهم جداً: OpenAI vision لازم mime يكون image/*
  if (safeMime.startsWith("image/")) {
    return `data:${safeMime};base64,${b64}`;
  }

  // fallback ذكي حسب header
  // JPEG
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return `data:image/jpeg;base64,${b64}`;
  }
  // PNG
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return `data:image/png;base64,${b64}`;
  }
  // WEBP "RIFF"
  if (buffer.length > 4 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return `data:image/webp;base64,${b64}`;
  }

  // آخر حل
  return `data:image/jpeg;base64,${b64}`;
}

function extFromAudioMimeOrName(mime, name) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();

  // name first (أفضل)
  if (n.endsWith(".m4a")) return "m4a";
  if (n.endsWith(".mp3")) return "mp3";
  if (n.endsWith(".wav")) return "wav";
  if (n.endsWith(".webm")) return "webm";
  if (n.endsWith(".mp4")) return "mp4";
  if (n.endsWith(".ogg")) return "ogg";
  if (n.endsWith(".oga")) return "oga";
  if (n.endsWith(".flac")) return "flac";

  // mime mapping
  if (m.includes("m4a") || m.includes("mp4")) return "m4a";     // iOS غالباً
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("flac")) return "flac";

  // بعض الأجهزة تعطي aac:
  if (m.includes("aac")) return "m4a";

  // fallback
  return "webm";
}

// ============================
// TEXT
// ============================
export async function diagnoseText({ message, preferredLanguage, vehicleInfo }) {
  if (!message || !message.trim()) {
    return { reply: "Please describe the problem first.", language: preferredLanguage || "auto" };
  }

  const lang = preferredLanguage || guessLanguage(message) || "auto";
  const issues = findRelevantIssues(message);

  const userPrompt = `
USER MESSAGE:
${message}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.4,
  });

  return { reply: extractReplyFromResponse(resp) || "No reply generated.", language: lang };
}

// ============================
// IMAGE (from multer buffer)
// ============================
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  imageBuffer,
  imageMime,
}) {
  // ✅ هنا سبب الإنكليزي عندك:
  // إذا المستخدم اختار صورة بدون رسالة، guessLanguage ما يشتغل -> يصير auto -> كثيراً يطلع English
  // الحل: إذا preferredLanguage موجود (حتى "ar") نلتزم به
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";

  const issues = findRelevantIssues((message || "").trim());

  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
Analyze the image and any context below.

CONTEXT (may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_VISION,
    instructions: buildSystemInstruction(lang),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    temperature: 0.35,
  });

  return { reply: extractReplyFromResponse(resp) || "No reply generated.", language: lang };
}

// ============================
// AUDIO (from multer buffer) -> whisper -> text diagnose
// ============================
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  audioBuffer,
  audioMime,
  audioOriginalName,
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";

  const issues = findRelevantIssues((message || "").trim());

  // ✅ أهم إصلاح للصوت:
  // نخزن الملف بامتداد صحيح حسب mime/original name
  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);

  fs.writeFileSync(tmpPath, audioBuffer);

  let transcriptText = "";
  try {
    const transcription = await openai.audio.transcriptions.create({
      model: MODEL_TRANSCRIBE,
      file: fs.createReadStream(tmpPath),
    });

    transcriptText = (transcription?.text || "").trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  const userPrompt = `
You will receive audio that was transcribed to text.
Use the transcription + any context to diagnose likely causes.

TRANSCRIPTION:
${transcriptText || "(Transcription empty or unclear)"}

CONTEXT (may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

If transcription is unclear:
- say it is unclear
- ask for a cleaner recording + where to record from (engine bay, wheel, undercarriage)
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.35,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
    transcript: transcriptText || null,
  };
}
