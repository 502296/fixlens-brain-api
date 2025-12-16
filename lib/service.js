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

// ✅ لغة بيضاء + تقرير واحد بدون عناوين/بولِت
function buildMechanicInstruction(lang) {
  return `
You are FixLens Doctor Mechanic — a highly experienced automotive diagnostician.
Always reply in the user's language (${lang || "auto"}), using “white language”:
simple, respectful, clear, not academic, not slang.

Write ONE professional mechanic-style report as normal paragraphs.
Do NOT use headings, bullet points, or numbered lists.
Do NOT include labels like: Summary, Causes, Next Steps, Safety, etc.

Be confident and helpful from the first sentence.
Use the provided evidence (user text, transcription, image) and mention uncertainty honestly.
If the audio/transcription is unclear, say that politely and ask for a better recording:
- where to record (engine bay / wheel / under car),
- cold vs warm engine,
- idle vs acceleration,
- distance from the sound source.

Keep it practical: what to check first and why, without pretending certainty.
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) return `data:${safeMime};base64,${b64}`;

  // fallback by header
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return `data:image/jpeg;base64,${b64}`;
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return `data:image/png;base64,${b64}`;
  if (buffer.length > 4 && buffer.toString("ascii", 0, 4) === "RIFF") return `data:image/webp;base64,${b64}`;
  return `data:image/jpeg;base64,${b64}`;
}

function extFromAudioMimeOrName(mime, name) {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();

  if (n.endsWith(".m4a")) return "m4a";
  if (n.endsWith(".mp3")) return "mp3";
  if (n.endsWith(".wav")) return "wav";
  if (n.endsWith(".webm")) return "webm";
  if (n.endsWith(".mp4")) return "mp4";
  if (n.endsWith(".ogg")) return "ogg";
  if (n.endsWith(".oga")) return "oga";
  if (n.endsWith(".flac")) return "flac";

  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("flac")) return "flac";

  return "webm";
}

// ============================
// TEXT
// ============================
export async function diagnoseText({ message, preferredLanguage, vehicleInfo }) {
  if (!message || !message.trim()) {
    const lang = preferredLanguage || "auto";
    return { reply: "اكتبلي شنو تشعر بالسيارة وبأي وقت يطلع الصوت أو العطل، وأنا أرتّبلك التشخيص بشكل واضح.", language: lang };
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
    instructions: buildMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.35,
  });

  return { reply: extractReplyFromResponse(resp) || "No reply generated.", language: lang };
}

// ============================
// IMAGE
// ============================
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  imageBuffer,
  imageMime,
  imageOriginalName,
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  const issues = findRelevantIssues((message || "").trim());

  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
Analyze the image as a mechanic would, and use any context below.

CONTEXT:
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

IMAGE FILE NAME:
${imageOriginalName || "(unknown)"}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_VISION,
    instructions: buildMechanicInstruction(lang),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    temperature: 0.3,
  });

  return { reply: extractReplyFromResponse(resp) || "No reply generated.", language: lang };
}

// ============================
// AUDIO -> Whisper -> Text Diagnose
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

  // ✅ نكتب ملف مؤقت بامتداد صحيح
  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, audioBuffer);

  let transcriptText = "";
  try {
    const opts = {
      model: MODEL_TRANSCRIBE,
      file: fs.createReadStream(tmpPath),
    };

    // ✅ إذا اللغة معروفة (مثل ar/en/es..) نمررها للـ Whisper يساعد بالدقة
    if (lang && lang !== "auto" && lang !== "cjk") {
      opts.language = lang;
    }

    const transcription = await openai.audio.transcriptions.create(opts);
    transcriptText = (transcription?.text || "").trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  const userPrompt = `
You received an audio recording that was transcribed.

TRANSCRIPTION:
${transcriptText || "(Transcription empty or unclear)"}

USER CONTEXT:
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

If the transcription is unclear, say it clearly and ask for a better recording with exact guidance.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.3,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
    transcript: transcriptText || null,
  };
}
