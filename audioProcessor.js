// audioProcessor.js
// FixLens Audio Processor v3.0
// Purpose:
// - Transcribe user speech reliably
// - Prepare for future vehicle-sound workflows
// - Keep one global multilingual path
// - Return stable fields for service.js

import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TRANSCRIBE_MODEL =
  process.env.FIXLENS_TRANSCRIBE_MODEL ||
  "gpt-4o-mini-transcribe";

function normalizeLocale(locale = "auto") {
  const value = String(locale || "").trim().toLowerCase();
  if (!value || value === "auto") return "";
  return value.split("-")[0];
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup error
  }
}

function buildTempAudioPath(ext = "m4a") {
  const id = crypto.randomBytes(8).toString("hex");
  return path.join(os.tmpdir(), `fixlens-audio-${id}.${ext}`);
}

function detectLikelyExtension(audioKind = "", mimeType = "", fileName = "") {
  const value = `${String(audioKind || "").toLowerCase()} ${String(mimeType || "").toLowerCase()} ${String(fileName || "").toLowerCase()}`;

  if (value.includes(".wav") || value.includes("audio/wav") || value.includes("wav")) return "wav";
  if (value.includes(".mp3") || value.includes("audio/mpeg") || value.includes("mpeg") || value.includes("mp3")) return "mp3";
  if (value.includes(".webm") || value.includes("audio/webm") || value.includes("webm")) return "webm";
  if (value.includes(".ogg") || value.includes("audio/ogg") || value.includes("ogg")) return "ogg";
  if (value.includes(".mp4") || value.includes("audio/mp4") || value.includes("mp4")) return "mp4";
  if (value.includes(".aac") || value.includes("audio/aac") || value.includes("aac")) return "aac";
  if (value.includes(".m4a") || value.includes("audio/m4a") || value.includes("m4a")) return "m4a";

  return "m4a";
}

function stripDataUrlPrefix(base64 = "") {
  return String(base64 || "").replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, "");
}

function extractAudioPayload(input) {
  if (!input) {
    return {
      audioBase64: "",
      locale: "auto",
      audioKind: "unknown",
      mimeType: "",
      fileName: "",
    };
  }

  if (typeof input === "string") {
    return {
      audioBase64: input,
      locale: "auto",
      audioKind: "unknown",
      mimeType: "",
      fileName: "",
    };
  }

  if (typeof input === "object") {
    return {
      audioBase64:
        input.audio ||
        input.audio_base64 ||
        input.audio_base_64 ||
        "",
      locale:
        input.locale ||
        input.lang ||
        input.language ||
        "auto",
      audioKind:
        input.audioKind ||
        input.audio_kind ||
        input.audioType ||
        input.audio_type ||
        "unknown",
      mimeType:
        input.mimeType ||
        input.mime_type ||
        input.audio_mime ||
        "",
      fileName:
        input.fileName ||
        input.filename ||
        input.audio_filename ||
        "",
    };
  }

  return {
    audioBase64: "",
    locale: "auto",
    audioKind: "unknown",
    mimeType: "",
    fileName: "",
  };
}

function cleanTranscript(text = "") {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferAudioNature({ transcript = "", audioKind = "unknown" }) {
  const t = String(transcript || "").toLowerCase();
  const kind = String(audioKind || "").toLowerCase();

  if (
    kind.includes("vehicle") ||
    kind.includes("noise") ||
    kind.includes("engine") ||
    kind.includes("car_sound") ||
    t.includes("knock") ||
    t.includes("tick") ||
    t.includes("rattle") ||
    t.includes("squeal") ||
    t.includes("صرير") ||
    t.includes("خبط") ||
    t.includes("طقطقة") ||
    t.includes("صوت")
  ) {
    return "vehicle_audio_or_noise";
  }

  return "speech_or_mixed_audio";
}

export async function processAudio(input = {}) {
  const { audioBase64, locale, audioKind, mimeType, fileName } = extractAudioPayload(input);

  if (!audioBase64 || typeof audioBase64 !== "string") {
    return {
      ok: true,
      text: "",
      language_hint: normalizeLocale(locale),
      audio_kind: audioKind || "unknown",
      audio_nature: "unknown",
      model: TRANSCRIBE_MODEL,
    };
  }

  const cleanBase64 = stripDataUrlPrefix(audioBase64);
  const extension = detectLikelyExtension(audioKind, mimeType || "audio/m4a", fileName);
  const tempPath = buildTempAudioPath(extension);

  try {
    fs.writeFileSync(tempPath, Buffer.from(cleanBase64, "base64"));

    const requestPayload = {
      file: fs.createReadStream(tempPath),
      model: TRANSCRIBE_MODEL,
    };

    const languageHint = normalizeLocale(locale);
    if (languageHint) {
      requestPayload.language = languageHint;
    }

    console.log("[AUDIO] base64_length:", cleanBase64.length);
    console.log("[AUDIO] mimeType:", mimeType || "");
    console.log("[AUDIO] fileName:", fileName || "");
    console.log("[AUDIO] detected_extension:", extension);
    console.log("[AUDIO] language_hint:", languageHint || "");

    const result = await client.audio.transcriptions.create(requestPayload);
    const text = cleanTranscript(result?.text || "");

    console.log("[AUDIO] transcript:", text || "(empty)");

    return {
      ok: true,
      text,
      language_hint: languageHint || "",
      audio_kind: audioKind || "unknown",
      audio_nature: inferAudioNature({
        transcript: text,
        audioKind,
      }),
      model: TRANSCRIBE_MODEL,
    };
  } catch (error) {
    console.error("Audio transcription failed:", error?.message || error);

    return {
      ok: false,
      text: "",
      language_hint: normalizeLocale(locale),
      audio_kind: audioKind || "unknown",
      audio_nature: "unknown",
      model: TRANSCRIBE_MODEL,
      error: error?.message || "audio_transcription_failed",
    };
  } finally {
    safeUnlink(tempPath);
  }
}
