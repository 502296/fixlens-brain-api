// service.js
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";

import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";

ffmpeg.setFfmpegPath(ffmpegPath);

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function isProbablyArabic(s = "") {
  return /[\u0600-\u06FF]/.test(s);
}

function stripDataUrl(b64 = "") {
  const s = String(b64 || "");
  const idx = s.indexOf("base64,");
  return idx >= 0 ? s.slice(idx + "base64,".length) : s;
}

function ensureTempDir() {
  const dir = path.join(os.tmpdir(), "fixlens");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTempFile(buffer, filenameHint = "file.bin") {
  const dir = ensureTempDir();
  const safe = filenameHint.replace(/[^\w.\-]+/g, "_");
  const p = path.join(dir, `${Date.now()}_${safe}`);
  fs.writeFileSync(p, buffer);
  return p;
}

// Convert any audio to wav to satisfy supported formats reliably
async function convertToWav(inputPath) {
  const dir = ensureTempDir();
  const outPath = path.join(dir, `${Date.now()}_audio.wav`);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-ac", "1",           // mono
        "-ar", "16000",       // 16 kHz
        "-f", "wav",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });

  return outPath;
}

function toImageContentFromBase64(image_base64) {
  if (!image_base64) return null;
  const raw = stripDataUrl(image_base64);
  if (!raw || raw.length < 50) return null;

  // OpenAI chat supports "image_url" with data URL
  // We'll assume jpeg if not specified
  const isDataUrl = String(image_base64).startsWith("data:image/");
  const dataUrl = isDataUrl ? String(image_base64) : `data:image/jpeg;base64,${raw}`;

  return {
    type: "image_url",
    image_url: { url: dataUrl },
  };
}

function safeUserLanguage({ locale, text }) {
  // If locale is given, trust it. Else infer Arabic quickly.
  const l = normalizeLocale(locale);
  if (l && l !== "en") return l;
  if (isProbablyArabic(text)) return "ar";
  return "en";
}

async function transcribeAudioFromBuffer(buffer, originalname = "audio.m4a") {
  // Save original buffer to temp file
  const inPath = writeTempFile(buffer, originalname);

  // Convert to wav to avoid "Invalid file format"
  const wavPath = await convertToWav(inPath);

  // Transcribe
  const fileStream = fs.createReadStream(wavPath);
  const model = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-transcribe";

  const tr = await client.audio.transcriptions.create({
    file: fileStream,
    model,
  });

  // Cleanup (best effort)
  try { fs.unlinkSync(inPath); } catch {}
  try { fs.unlinkSync(wavPath); } catch {}

  return (tr?.text || "").trim();
}

async function buildChatCompletion({ locale, text, transcript, imageContent }) {
  const sys = buildDoctorSystemPrompt();
  const userLang = safeUserLanguage({ locale, text: text || transcript || "" });

  const model = process.env.OPENAI_MODEL_TEXT || "gpt-4o";

  const userText = buildDoctorUserMessage({
    text,
    transcript,
    hasImage: !!imageContent,
    hasAudio: !!transcript,
  });

  const userContent = [];
  userContent.push({ type: "text", text: userText });
  if (imageContent) userContent.push(imageContent);

  const resp = await client.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: sys },
      // Force language consistency using a small hint
      { role: "system", content: `Reply language must be: ${userLang}` },
      { role: "user", content: userContent },
    ],
  });

  const reply = resp?.choices?.[0]?.message?.content?.trim() || "";
  return { reply, language: userLang };
}

export async function handleFixLensRequest(payload) {
  const locale = normalizeLocale(payload?.locale || "en");
  const text = typeof payload?.text === "string" ? payload.text : "";

  // Image: multipart or base64
  let imageContent = null;

  if (payload?.image_file?.buffer) {
    // convert multipart image buffer to base64 data url
    const mime = payload.image_file.mimetype || "image/jpeg";
    const b64 = payload.image_file.buffer.toString("base64");
    imageContent = {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${b64}` },
    };
  } else {
    imageContent = toImageContentFromBase64(payload?.image_base64);
  }

  // Audio: multipart or base64
  let transcript = "";
  try {
    if (payload?.audio_file?.buffer) {
      transcript = await transcribeAudioFromBuffer(
        payload.audio_file.buffer,
        payload.audio_file.originalname || "audio.m4a"
      );
    } else if (payload?.audio_base64) {
      const raw = stripDataUrl(payload.audio_base64);
      const buf = Buffer.from(raw, "base64");
      const name = payload?.audio_filename || "audio.m4a";
      transcript = await transcribeAudioFromBuffer(buf, name);
    }
  } catch (e) {
    // Do not fail the whole request because audio failed
    console.error("Audio transcribe error:", e?.message || e);
    transcript = "";
  }

  // If nothing provided
  if (!text.trim() && !transcript.trim() && !imageContent) {
    return {
      reply:
        locale === "ar"
          ? "اكتب المشكلة باختصار (سنة السيارة + الموديل + الأعراض + متى تظهر)."
          : "Please type the issue (year + make/model + symptoms + when it happens).",
      language: locale,
      meta: { hadText: false, hadAudio: false, hadImage: false },
    };
  }

  // Build response
  const out = await buildChatCompletion({
    locale,
    text,
    transcript,
    imageContent,
  });

  // Safety fallback if empty
  const finalReply =
    out.reply && out.reply.length > 3
      ? out.reply
      : locale === "ar"
      ? "صارت مشكلة بسيطة بالتحليل. اكتب الأعراض مرة ثانية بجملة واحدة وسأعطيك تشخيصًا عمليًا فورًا."
      : "There was a small analysis issue. Please retry with one short sentence and I’ll respond immediately.";

  return {
    reply: finalReply,
    language: out.language,
    meta: {
      model_text: process.env.OPENAI_MODEL_TEXT || "gpt-4o",
      model_transcribe: process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-transcribe",
      hadText: !!text.trim(),
      hadAudio: !!transcript.trim(),
      hadImage: !!imageContent,
    },
  };
}
