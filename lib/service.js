// lib/service.js
import OpenAI from "openai";
import { findRelevantIssues } from "./autoKnowledge.js";

// ============================
// OpenAI Client
// ============================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ============================
// Models (customizable via env)
// ============================
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

// ملاحظة: موديل الصوت يختلف حسب حسابك/الدعم.
// إذا فشل، غيره من env بدون تعديل الكود.
const MODEL_AUDIO =
  process.env.OPENAI_MODEL_AUDIO ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

// ============================
// Helpers
// ============================
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // Arabic
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  // Russian
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Greek
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  // Chinese/Japanese/Korean (rough)
  if (/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(t)) return "cjk";

  // Default english-ish
  return "en";
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function extractReplyFromResponse(resp) {
  // Responses API عادة يرجّع output_text
  if (resp?.output_text) return resp.output_text;

  // fallback: حاول تجمع النص من output
  const out = resp?.output;
  if (Array.isArray(out)) {
    const parts = [];
    for (const item of out) {
      if (item?.content && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && c?.text) parts.push(c.text);
          if (c?.type === "text" && c?.text) parts.push(c.text);
        }
      }
    }
    if (parts.length) return parts.join("\n").trim();
  }

  // fallback أخير
  return "";
}

function buildSystemInstruction(lang) {
  return `
You are FixLens Auto — a world-class vehicle diagnostic AI.
Be concise but professional.
Always respond in the user's language (${lang || "auto"}).
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

function normalizeBase64(data) {
  if (!data) return null;
  // remove data URL header if present: data:audio/webm;base64,...
  const m = String(data).match(/^data:.*;base64,(.*)$/);
  return m ? m[1] : String(data);
}

function ensureDataUrl(base64, mime) {
  if (!base64) return null;
  const raw = normalizeBase64(base64);
  const type = mime || "application/octet-stream";
  return `data:${type};base64,${raw}`;
}

function detectImageMimeFromBase64(base64) {
  const raw = normalizeBase64(base64);
  if (!raw) return null;
  // very rough signatures
  if (raw.startsWith("/9j/")) return "image/jpeg";
  if (raw.startsWith("iVBORw0KGgo")) return "image/png";
  if (raw.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

function detectAudioMimeFromFilenameOrHint(nameOrMime) {
  const v = (nameOrMime || "").toLowerCase();
  if (v.includes("webm")) return "audio/webm";
  if (v.includes("wav")) return "audio/wav";
  if (v.includes("mpeg") || v.includes("mp3")) return "audio/mpeg";
  if (v.includes("m4a") || v.includes("mp4")) return "audio/mp4";
  return "audio/webm";
}

// ============================
// Core: Text Diagnosis
// ============================
export async function diagnoseText({
  message,
  preferredLanguage,
  vehicleInfo, // optional string
}) {
  if (!message || !message.trim()) {
    return {
      reply: "Please describe the problem first.",
      language: preferredLanguage || "auto",
    };
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
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    // You can tighten/loosen:
    temperature: 0.4,
  });

  const reply = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply, language: lang };
}

// ============================
// Core: Image Diagnosis
// Supports either imageUrl OR imageBase64
// ============================
export async function diagnoseImage({
  message, // optional context text
  preferredLanguage,
  imageUrl, // optional
  imageBase64, // optional
  imageMime, // optional
  vehicleInfo, // optional string
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";

  const contextText = (message || "").trim();
  const issues = findRelevantIssues(contextText);

  let finalImageUrl = imageUrl;
  if (!finalImageUrl && imageBase64) {
    const mime = imageMime || detectImageMimeFromBase64(imageBase64) || "image/jpeg";
    finalImageUrl = ensureDataUrl(imageBase64, mime);
  }

  if (!finalImageUrl) {
    return {
      reply: "No image provided. Please attach an image to diagnose.",
      language: lang,
    };
  }

  const userPrompt = `
Analyze the image and any context below.

CONTEXT (may be empty):
${contextText || "(no text provided)"}

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
          { type: "input_image", image_url: finalImageUrl },
        ],
      },
    ],
    temperature: 0.35,
  });

  const reply = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply, language: lang };
}

// ============================
// Core: Audio Diagnosis
// Supports audioBase64 (preferred) + mime
//
// IMPORTANT:
// We send audio as input_file (supported type).
// If your account/model doesn’t support audio reasoning,
// you can still transcribe first (separate flow) — لكن هذا الكود جاهز.
// ============================
export async function diagnoseAudio({
  message, // optional context text
  preferredLanguage,
  audioBase64, // required
  audioMime, // optional (audio/webm, audio/wav, audio/mpeg...)
  vehicleInfo, // optional
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  if (!audioBase64) {
    return {
      reply: "No audio provided. Please record a voice note to diagnose.",
      language: lang,
    };
  }

  const contextText = (message || "").trim();
  const issues = findRelevantIssues(contextText);

  // Build a data URL so OpenAI can receive it as file content
  const mime = audioMime || detectAudioMimeFromFilenameOrHint(audioMime) || "audio/webm";
  const audioDataUrl = ensureDataUrl(audioBase64, mime);

  const userPrompt = `
You will receive an audio clip.
Diagnose based on the sound characteristics (knocking, squealing, ticking, grinding, misfire rhythm, belt noise, etc.)
If the audio is unclear, say so and ask for a better recording.

CONTEXT (may be empty):
${contextText || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_AUDIO,
    instructions: buildSystemInstruction(lang),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },

          // ✅ audio is sent as input_file (NOT input_audio)
          {
            type: "input_file",
            filename: `audio.${mime.includes("wav") ? "wav" : mime.includes("mpeg") ? "mp3" : "webm"}`,
            file_data: audioDataUrl,
          },
        ],
      },
    ],
    temperature: 0.35,
  });

  const reply = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply, language: lang };
}

// ============================
// Convenience Router Function (optional)
// call diagnoseAny({ type: "text"|"image"|"audio", ...payload })
// ============================
export async function diagnoseAny(payload) {
  const type = payload?.type;
  if (type === "text") return diagnoseText(payload);
  if (type === "image") return diagnoseImage(payload);
  if (type === "audio") return diagnoseAudio(payload);

  return {
    reply: "Invalid diagnose type. Use text, image, or audio.",
    language: payload?.preferredLanguage || "auto",
  };
}
