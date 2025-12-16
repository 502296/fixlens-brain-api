// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
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

// ✅ نفس قرارنا: تقرير واحد، بدون عناوين ولا نقاط، ولغة بيضاء
function buildSystemInstruction(lang) {
  return `
You are FixLens Auto — a world-class mechanic-style vehicle diagnostic assistant.
Always reply in the user's language (${lang || "auto"}).
Use "white language": simple, respectful, professional; not academic; not street slang.

Important output rules:
- Write ONE single professional report as normal paragraphs.
- No headings, no bullet points, no numbering.
- Sound confident and helpful from the first sentence, like an expert mechanic.
- Do not claim certainty. Use likelihood language.
- If info is missing, ask ONLY 2–3 targeted questions inside the same report (not as a list).
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) return `data:${safeMime};base64,${b64}`;

  // fallback
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

  if (m.includes("m4a") || m.includes("mp4")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("flac")) return "flac";
  if (m.includes("aac")) return "m4a";

  return "webm";
}

async function convertToWav16kMono(inputPath, outputPath) {
  // يشتغل حتى لو ffmpeg مو منصّب بالنظام لأن عدنا ffmpeg-static
  ffmpeg.setFfmpegPath(ffmpegPath);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-ac", "1",
        "-ar", "16000",
        "-vn"
      ])
      .toFormat("wav")
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
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
}) {
  const lang = preferredLanguage || guessLanguage(message || "") || "auto";
  const issues = findRelevantIssues((message || "").trim());
  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
Analyze the image and any context below.

CONTEXT:
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
    temperature: 0.3,
  });

  return { reply: extractReplyFromResponse(resp) || "No reply generated.", language: lang };
}

// ============================
// AUDIO -> convert to WAV -> whisper -> text diagnose
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

  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpIn = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}_16k_mono.wav`);

  fs.writeFileSync(tmpIn, audioBuffer);

  let transcriptText = "";
  let transcribeError = null;

  try {
    // ✅ تحويل قوي قبل التفريغ
    await convertToWav16kMono(tmpIn, tmpWav);

    const transcription = await openai.audio.transcriptions.create({
      model: MODEL_TRANSCRIBE,
      file: fs.createReadStream(tmpWav),
    });

    transcriptText = (transcription?.text || "").trim();
  } catch (e) {
    transcribeError = e?.message || String(e);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }

  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;

  // ✅ Prompt احترافي: إذا ماكو كلام، لا نكذب… نسوي fallback ذكي
  const userPrompt = `
You received an audio clip.

TRANSCRIPTION (may be empty if the clip has only engine noise):
${transcriptText || "(no clear speech detected)"}

CONTEXT (user typed message, may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

If transcription is empty or unclear:
- Do NOT pretend you heard specific parts.
- Explain briefly that the clip seems to contain mostly mechanical noise with no clear speech.
- Ask the user to send either:
  (a) a short text description of the noise and when it happens, OR
  (b) a new recording where they capture 8–10 seconds of the noise then speak 5 seconds describing it (same recording).
- Still give a useful mechanic-style direction: what to check first based on the context, and what extra detail would narrow it down.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.3,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
    transcript: transcriptLooksEmpty ? null : transcriptText,
    // إذا تحب لاحقًا نرجّع error داخليًا بس بدون ما يظهر للمستخدم
    transcribe_error: transcribeError || null,
  };
}
