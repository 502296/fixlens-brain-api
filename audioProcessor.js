// audioProcessor.js
// FixLens Audio Processor v2.0
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

function detectLikelyExtension(audioKind = "", mimeType = "") {
  const value = `${String(audioKind || "").toLowerCase()} ${String(mimeType || "").toLowerCase()}`;

  if (value.includes("wav")) return "wav";
  if (value.includes("mp3") || value.includes("mpeg")) return "mp3";
  if (value.includes("webm")) return "webm";
  if (value.includes("ogg")) return "ogg";
  if (value.includes("mp4")) return "mp4";
  if (value.includes("aac")) return "aac";
  return "m4a";
}

function extractAudioPayload(input) {
  if (!input) {
    return {
      audioBase64: "",
      locale: "auto",
      audioKind: "unknown",
      mimeType: "",
    };
  }

  if (typeof input === "string") {
    return {
      audioBase64: input,
      locale: "auto",
      audioKind: "unknown",
      mimeType: "",
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
        "",
    };
  }

  return {
    audioBase64: "",
    locale: "auto",
    audioKind: "unknown",
    mimeType: "",
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
  const { audioBase64, locale, audioKind, mimeType } = extractAudioPayload(input);

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

  const extension = detectLikelyExtension(audioKind, mimeType);
  const tempPath = buildTempAudioPath(extension);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const requestPayload = {
      file: fs.createReadStream(tempPath),
      model: TRANSCRIBE_MODEL,
    };

    const languageHint = normalizeLocale(locale);
    if (languageHint) {
      requestPayload.language = languageHint;
    }

    const result = await client.audio.transcriptions.create(requestPayload);

    const text = cleanTranscript(result?.text || "");

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
