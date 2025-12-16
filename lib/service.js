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
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
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
          if ((c?.type === "output_text" || c?.type === "text") && c?.text)
            parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }
  return "";
}

/**
 * System instruction: “white language” + single professional report.
 * ممنوع headings أو bullets أو “Summary/Causes…”.
 */
function buildSystemInstruction(lang) {
  return `
You are FixLens Doctor Mechanic — an expert vehicle diagnostician.
Always reply in the user's language (${lang || "auto"}), using a neutral “white language”:
- simple, respectful, professional
- not academic, not slang/street
- clear and confident, without exaggeration

OUTPUT RULES (very important):
- Write ONE continuous professional mechanic-style report.
- Do NOT use headings, section titles, numbered lists, or bullet points.
- Start with a strong opening line that shows competence.
- Include: what you understand, likely causes (with uncertainty), what to check first, what is safe/unsafe, and 2–4 short follow-up questions naturally inside the report (not as a list).
- If information is insufficient, say exactly what is missing and how to capture it (where to record sound / what to observe), without sounding generic.

Never claim certainty from audio/image alone.
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) {
    return `data:${safeMime};base64,${b64}`;
  }

  // fallback by signature
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return `data:image/jpeg;base64,${b64}`;
  }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return `data:image/png;base64,${b64}`;
  }
  if (buffer.length > 4 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return `data:image/webp;base64,${b64}`;
  }

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

  if (m.includes("m4a") || m.includes("mp4")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("flac")) return "flac";
  if (m.includes("aac")) return "m4a";

  return "webm";
}

/**
 * Smart fallback message in user language, “white language”.
 */
function fallbackMessage(lang) {
  if (lang === "ar") {
    return "تمام، وصلتني المعلومة، بس حتى أشخّص بدقّة أكثر أحتاج تفاصيل إضافية. إذا تقدر، اكتب شنو الأعراض بالضبط ومتى تظهر، وهل أكو لمبة تحذير؟ وإذا الموضوع صوت، سجّل من أقرب مكان للصوت: غرفة المحرك أو عند العجلة أو تحت السيارة، وخلي التسجيل 8–12 ثانية بدون كلام وبهدوء قدر الإمكان.";
  }
  return "I can help, but I need a bit more detail to be accurate. Tell me exactly what you notice and when it happens, and whether any warning light is on. If this is a sound issue, record 8–12 seconds close to the sound source (engine bay / wheel area / undercarriage) with minimal talking and background noise.";
}

// ============================
// TEXT
// ============================
export async function diagnoseText({ message, preferredLanguage, vehicleInfo }) {
  if (!message || !message.trim()) {
    const lang = preferredLanguage || "auto";
    return { reply: fallbackMessage(lang), language: lang };
  }

  const lang = preferredLanguage || guessLanguage(message) || "auto";
  const issues = findRelevantIssues(message);

  const userPrompt = `
USER MESSAGE:
${message}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant internal hints (may be empty):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.35,
  });

  const reply = extractReplyFromResponse(resp);
  return { reply: reply || fallbackMessage(lang), language: lang };
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
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  const issues = findRelevantIssues((message || "").trim());
  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
Analyze the image and the context. The user may provide no text.

CONTEXT:
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant internal hints (may be empty):
${JSON.stringify(issues || [], null, 2)}

Important:
- If the image alone is not enough, say what is missing (symptoms, sounds, dashboard lights, behavior).
- Still write ONE continuous professional report (no headings, no bullets).
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

  const reply = extractReplyFromResponse(resp);
  return { reply: reply || fallbackMessage(lang), language: lang };
}

// ============================
// AUDIO  ✅ NEW “A” VERSION
// Whisper transcription -> ONE text diagnosis
// (No second OpenAI file upload, no input_file, less load, fewer 502)
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

  // Save temp file with correct extension
  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  fs.writeFileSync(tmpPath, audioBuffer);

  let transcriptText = "";
  try {
    // 1) Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      model: MODEL_TRANSCRIBE,
      file: fs.createReadStream(tmpPath),
    });

    transcriptText = (transcription?.text || "").trim();
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }

  // If transcription is empty, we still respond smartly
  const userPrompt = `
You received an audio clip. It was transcribed to text.
Use the transcription + context to diagnose.

TRANSCRIPTION (may be empty):
${transcriptText || "(empty/unclear transcription)"}

CONTEXT:
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant internal hints (may be empty):
${JSON.stringify(issues || [], null, 2)}

Rules:
- If transcription is unclear, explain it briefly and tell the user exactly how to re-record (where to record from, how long, engine idle vs rev, inside/outside).
- Write ONE continuous professional report (no headings, no bullets).
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.35,
  });

  const reply = extractReplyFromResponse(resp);

  return {
    reply: reply || fallbackMessage(lang),
    language: lang,
    transcript: transcriptText || null,
  };
}
