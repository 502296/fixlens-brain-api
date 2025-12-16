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
          if ((c?.type === "output_text" || c?.type === "text") && c?.text) {
            parts.push(c.text);
          }
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }
  return "";
}

/**
 * ✅ DOCTOR MECHANIC STYLE (ONE PROFESSIONAL REPORT)
 * - No headings
 * - No bullets
 * - No lists like Summary/Causes/Next steps
 * - End with 2–3 short follow-up questions (not numbered)
 */
function buildSystemInstruction(lang) {
  const L = lang || "auto";
  return `
You are FixLens Doctor Mechanic — a senior automotive diagnostic engineer.

LANGUAGE:
- Reply ONLY in the user's language: ${L}.
- If ${L} is "auto", infer the user's language from the user's text. If there is no text at all, default to the device-preferred language if provided; otherwise use clear English.

STYLE:
- Write ONE professional mechanic report as normal paragraphs.
- DO NOT use headings or sections.
- DO NOT use bullet points or numbered lists.
- Do not say "Quick Summary", "Most Likely Causes", "Recommended Next Steps", "Safety Warnings".
- Keep it realistic: explain what you can conclude and what you cannot.
- Mention safety cautions naturally inside the report (without a section).

DIAGNOSTIC BEHAVIOR:
- Prefer evidence-based checks.
- Avoid claiming a single exact part is bad unless strongly supported.
- Use probabilities/likelihood phrasing naturally (e.g., "often", "commonly", "less likely").

END:
- Finish with 2–3 short follow-up questions on separate lines (no numbering).
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) {
    return `data:${safeMime};base64,${b64}`;
  }

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

// ============================
// TEXT
// ============================
export async function diagnoseText({ message, preferredLanguage, vehicleInfo }) {
  if (!message || !message.trim()) {
    return {
      reply: "Please describe the problem first.",
      language: preferredLanguage || "auto",
    };
  }

  const lang = preferredLanguage || guessLanguage(message) || "auto";
  const issues = findRelevantIssues(message);

  const userPrompt = `
User message:
${message}

${vehicleInfo ? `Vehicle info:\n${vehicleInfo}\n` : ""}

Internal reference (may be empty):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.25,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
  };
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
  // ✅ اللغة: إذا ماكو نص، خذ preferredLanguage إذا موجود
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  const issues = findRelevantIssues((message || "").trim());

  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
You are analyzing a vehicle-related image.

User context (may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `Vehicle info:\n${vehicleInfo}\n` : ""}

Internal reference (may be empty):
${JSON.stringify(issues || [], null, 2)}

If the image alone is insufficient for diagnosis, say what is missing and ask for the most useful details.
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
    temperature: 0.2,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
  };
}

// ============================
// AUDIO (multer buffer) -> whisper -> text diagnose
// ============================
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  audioBuffer,
  audioMime,
  audioOriginalName,
}) {
  // أولًا خذ اللغة من preferredLanguage إن وجدت، وإلا من رسالة المستخدم
  let lang = preferredLanguage || guessLanguage(message || "") || "auto";

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

  // ✅ إذا ما عندنا لغة ثابتة، وخلي التفريغ هو اللي يحددها
  if ((!preferredLanguage || preferredLanguage === "auto") && transcriptText) {
    lang = guessLanguage(transcriptText) || lang;
  }

  // ✅ إذا التفريغ ضعيف/قصير جدًا: رد احترافي (مو "غير واضح" فقط)
  const tooShort = !transcriptText || transcriptText.length < 8;
  if (tooShort) {
    const arMsg =
      "التسجيل يبدو أنه ضجيج محرك/بيئة بدون كلام واضح أو أن الصوت بعيد، وهذا لا يكفي لتشخيص دقيق من الصوت وحده. حاول تسجيل 10–15 ثانية قرب مصدر الصوت مباشرة (داخل حجرة المحرك أو عند العجلة/أسفل السيارة) بدون رياح، ويفضل مع حالتين: على السكون ثم أثناء الدعس الخفيف. اكتب سطرًا واحدًا يوضح متى يظهر الصوت ومن أي جهة، وسأعطيك تقرير تشخيصي أقوى.";
    const enMsg =
      "The recording sounds like engine/ambient noise without clear speech (or it’s too far), so it’s not enough for a precise diagnosis from audio alone. Re-record 10–15 seconds very close to the sound source (engine bay or wheel/undercarriage), minimize wind, and capture two moments: idle and light throttle. Add one short line describing when it happens and where it comes from, and I’ll produce a stronger diagnostic report.";

    return {
      reply: (lang === "ar") ? arMsg : enMsg,
      language: lang,
      transcript: transcriptText || null,
    };
  }

  const issues = findRelevantIssues(`${message || ""}\n${transcriptText}`.trim());

  const userPrompt = `
Audio was transcribed to text.

Transcription:
${transcriptText}

User context (may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `Vehicle info:\n${vehicleInfo}\n` : ""}

Internal reference (may be empty):
${JSON.stringify(issues || [], null, 2)}

Important: do not pretend you can "hear" exact mechanical faults from noise if the transcript doesn't describe them. Use the transcript + context, ask for specific missing details, and write a professional engineer report.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.22,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
    transcript: transcriptText || null,
  };
}
