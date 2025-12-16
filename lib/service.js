// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";

import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { decode } from "wav-decoder";

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

// ✅ أهم تعديل: لغة بيضاء + تقرير واحد بدون عناوين/قوائم
function buildSystemInstruction(lang) {
  return `
You are FixLens Doctor Mechanic — a top-tier automotive diagnostician.
Always reply in the user's language (${lang || "auto"}), using "white language": simple, respectful, clear, not academic, not street slang.

STYLE RULES:
- Write ONE professional mechanic-style report as normal text (no headings, no bullet points, no numbering).
- Do NOT output labels like: Summary, Causes, Next steps, Safety, Follow-up questions.
- Start strongly from the first sentence so the user feels confidence and expertise.
- Be practical and test-based: what to check first, what to listen for, what to scan, what to inspect.
- If info is missing, ask only the most important 2–3 questions inside the same report (as short questions, not a list).
- Never claim certainty from audio alone; give likely possibilities and quick checks.
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
// AUDIO DSP (actual audio analysis)
// ============================
ffmpeg.setFfmpegPath(ffmpegStatic);

// Convert any audio -> WAV 16k mono for analysis
async function convertToWav16kMono(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-ac 1",       // mono
        "-ar 16000",   // 16k
        "-f wav",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

function clamp01(x) {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function computeRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function computeZCR(samples) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) crossings++;
  }
  return crossings / Math.max(1, samples.length);
}

// Simple spectral features using short-time analysis (no heavy FFT deps)
function computeSpectralProxy(samples, sampleRate) {
  // We will use a lightweight approach: estimate "brightness" by average absolute derivative
  // This correlates with higher frequency content.
  let derivSum = 0;
  for (let i = 1; i < samples.length; i++) {
    derivSum += Math.abs(samples[i] - samples[i - 1]);
  }
  const avgDeriv = derivSum / Math.max(1, samples.length - 1);

  // Map to rough bands [0..1]
  // Typical: idle low-frequency -> small avgDeriv, squeal/whine -> higher avgDeriv
  const brightness = clamp01(avgDeriv * 12); // tuned scale

  // Rough "tone" indicator: periodicity proxy using autocorr on a small window
  const N = Math.min(samples.length, sampleRate * 1); // 1 sec max
  const win = samples.slice(0, N);
  let bestLag = 0;
  let bestCorr = 0;

  // Search lags between 80Hz..800Hz
  const minLag = Math.floor(sampleRate / 800);
  const maxLag = Math.floor(sampleRate / 80);

  for (let lag = minLag; lag <= maxLag; lag += 10) {
    let corr = 0;
    for (let i = 0; i < win.length - lag; i += 5) {
      corr += win[i] * win[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }
  const estimatedHz = bestLag ? Math.round(sampleRate / bestLag) : null;

  return { brightness, estimatedHz };
}

function classifyAudioProfile({ rms, zcr, brightness, estimatedHz }) {
  // Heuristic classification (good enough for "today shipping")
  // - squeal/whine: high brightness, moderate rms
  // - knock/tick: moderate brightness, higher transient feel (we approximate via zcr + rms)
  // - rumble: higher rms, low brightness
  // - hiss: high zcr, medium brightness
  let label = "general engine/road noise";
  const notes = [];

  if (brightness > 0.7 && rms > 0.03) {
    label = "high-frequency squeal/whine tendency";
    notes.push("Often associated with belts, pulleys, alternator whine, or vacuum/air leaks depending on when it happens.");
  } else if (rms > 0.06 && brightness < 0.35) {
    label = "low-frequency rumble/knocking tendency";
    notes.push("Often associated with mounts, exhaust contact, wheel/bearing rumble, or deeper engine knock depending on RPM relation.");
  } else if (brightness > 0.45 && zcr < 0.08) {
    label = "rhythmic ticking/clicking tendency";
    notes.push("Could relate to lifters, injectors, EVAP purge, or light valvetrain noise depending on location and temperature.");
  } else if (zcr > 0.12 && brightness > 0.4) {
    label = "hiss/air-like noise tendency";
    notes.push("Could relate to vacuum leaks, intake leaks, or air escaping depending on load and idle behavior.");
  }

  if (estimatedHz) {
    notes.push(`A tonal component is present around ~${estimatedHz} Hz (rough estimate).`);
  }

  return { label, notes };
}

async function analyzeAudioBuffer(audioTmpPath, wavTmpPath) {
  await convertToWav16kMono(audioTmpPath, wavTmpPath);

  const wavData = fs.readFileSync(wavTmpPath);
  const decoded = await decode(wavData);

  const sampleRate = decoded.sampleRate || 16000;
  const chan = decoded.channelData?.[0];
  if (!chan || chan.length < 2000) {
    return {
      ok: false,
      reason: "WAV decode failed or too short",
    };
  }

  // Use first 6 seconds max for quick analysis
  const maxSamples = Math.min(chan.length, sampleRate * 6);
  const samples = chan.slice(0, maxSamples);

  const rms = computeRMS(samples);
  const zcr = computeZCR(samples);
  const { brightness, estimatedHz } = computeSpectralProxy(samples, sampleRate);

  const cls = classifyAudioProfile({ rms, zcr, brightness, estimatedHz });

  return {
    ok: true,
    sampleRate,
    secondsAnalyzed: Math.round(maxSamples / sampleRate),
    rms: Number(rms.toFixed(4)),
    zcr: Number(zcr.toFixed(4)),
    brightness: Number(brightness.toFixed(3)),
    estimatedHz,
    classification: cls.label,
    notes: cls.notes,
  };
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

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
  };
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

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
  };
}

// ============================
// AUDIO (actual analysis + whisper fallback)
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

  // temp paths
  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const audioTmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const wavTmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.wav`);

  fs.writeFileSync(audioTmpPath, audioBuffer);

  let transcriptText = "";
  let audioAnalysis = null;

  try {
    // 1) Real audio analysis (WAV + features)
    try {
      audioAnalysis = await analyzeAudioBuffer(audioTmpPath, wavTmpPath);
    } catch (e) {
      audioAnalysis = { ok: false, reason: e?.message || String(e) };
    }

    // 2) Whisper transcription (if user spoke)
    // حتى لو الصوت محرك فقط، نخليه يحاول، بس ما نعتمد عليه وحده
    try {
      const transcription = await openai.audio.transcriptions.create({
        model: MODEL_TRANSCRIBE,
        file: fs.createReadStream(audioTmpPath),
      });
      transcriptText = (transcription?.text || "").trim();
    } catch {
      transcriptText = "";
    }
  } finally {
    try { fs.unlinkSync(audioTmpPath); } catch {}
    try { fs.unlinkSync(wavTmpPath); } catch {}
  }

  const contextText = (message || "").trim();
  const issues = findRelevantIssues(contextText);

  const userPrompt = `
You are diagnosing from vehicle audio.

AUDIO ANALYSIS (computed from waveform):
${JSON.stringify(audioAnalysis || {}, null, 2)}

TRANSCRIPTION (may be empty):
${transcriptText || "(no clear speech detected)"}

USER CONTEXT (may be empty):
${contextText || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

CRITICAL:
- Write one strong mechanic-style report (no headings, no bullets, no labels).
- Use the audio analysis as evidence (richer than transcription).
- If the recording is not ideal, stay confident and guide the user on a better recording (where to record and what to do) inside the same report.
- Ask 2–3 key questions inside the report (not as a list).
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
    audioAnalysis: audioAnalysis || null,
  };
}
