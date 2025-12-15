import OpenAI from "openai";
import { findRelevantIssues } from "./autoKnowledge.js";

import fs from "fs";
import os from "os";
import path from "path";

// ============================
// OpenAI Client (robust env lookup)
// ============================
const apiKey =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI_TOKEN ||
  "";

if (!apiKey || !apiKey.trim()) {
  throw new Error(
    "Missing OPENAI_API_KEY. Please set OPENAI_API_KEY in Railway Variables for this service/environment."
  );
}

const openai = new OpenAI({ apiKey });

// ============================
// Models
// ============================
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION ||
  process.env.OPENAI_MODEL ||
  "gpt-4o-mini";

const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  "whisper-1";

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
          if (c?.type === "output_text" && c?.text) parts.push(c.text);
          if (c?.type === "text" && c?.text) parts.push(c.text);
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
  const m = String(data).match(/^data:.*;base64,(.*)$/);
  return m ? m[1] : String(data);
}

function ensureDataUrl(base64, mime) {
  if (!base64) return null;
  const raw = normalizeBase64(base64);
  const type = mime || "image/jpeg";
  return `data:${type};base64,${raw}`;
}

function safeImageMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return m;
  // ✅ Fix for application/octet-stream from Flutter sometimes
  return "image/jpeg";
}

function safeAudioMime(mime) {
  const m = (mime || "").toLowerCase();
  // Accept common formats for Whisper
  if (
    m.includes("webm") ||
    m.includes("wav") ||
    m.includes("mpeg") ||
    m.includes("mp3") ||
    m.includes("mp4") ||
    m.includes("m4a") ||
    m.includes("ogg") ||
    m.includes("oga") ||
    m.includes("flac")
  ) {
    // Normalize a bit
    if (m.includes("mp3") || m.includes("mpeg")) return "audio/mpeg";
    if (m.includes("wav")) return "audio/wav";
    if (m.includes("mp4") || m.includes("m4a")) return "audio/mp4";
    if (m.includes("ogg") || m.includes("oga")) return "audio/ogg";
    if (m.includes("flac")) return "audio/flac";
    return "audio/webm";
  }
  return "audio/webm";
}

function extFromAudioMime(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("ogg") || m.includes("oga")) return "ogg";
  if (m.includes("flac")) return "flac";
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

  const reply = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply, language: lang };
}

// ============================
// IMAGE (supports imageBase64 OR imageBuffer)
// ============================
export async function diagnoseImage({
  message,
  preferredLanguage,
  imageUrl,
  imageBase64,
  imageMime,
  imageBuffer,
  vehicleInfo,
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  const contextText = (message || "").trim();
  const issues = findRelevantIssues(contextText);

  let finalImageUrl = imageUrl;

  // ✅ If we got a Buffer (from multer), convert to base64 data URL
  if (!finalImageUrl && imageBuffer) {
    const mime = safeImageMime(imageMime);
    const b64 = Buffer.from(imageBuffer).toString("base64");
    finalImageUrl = ensureDataUrl(b64, mime);
  }

  // Base64 string (if provided directly)
  if (!finalImageUrl && imageBase64) {
    const mime = safeImageMime(imageMime);
    finalImageUrl = ensureDataUrl(imageBase64, mime);
  }

  if (!finalImageUrl) {
    return { reply: "No image provided. Please attach an image to diagnose.", language: lang };
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
// AUDIO (supports audioBase64 OR audioBuffer)
// ============================
export async function diagnoseAudio({
  message,
  preferredLanguage,
  audioBase64,
  audioMime,
  audioBuffer,
  vehicleInfo,
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";

  const hasB64 = !!audioBase64;
  const hasBuf = !!audioBuffer;
  if (!hasB64 && !hasBuf) {
    return { reply: "No audio provided. Please record a voice note to diagnose.", language: lang };
  }

  const contextText = (message || "").trim();
  const issues = findRelevantIssues(contextText);

  const mime = safeAudioMime(audioMime);
  const ext = extFromAudioMime(mime);

  // Write to temp file for Whisper
  const tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);

  if (hasBuf) {
    fs.writeFileSync(tmpPath, Buffer.from(audioBuffer));
  } else {
    const raw = normalizeBase64(audioBase64);
    fs.writeFileSync(tmpPath, Buffer.from(raw, "base64"));
  }

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
${contextText || "(no text provided)"}

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

  const reply = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply, language: lang, transcript: transcriptText || null };
}
