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
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";

// نموذج خفيف لكشف اللغة (ممكن يكون نفس MODEL_TEXT)
const MODEL_LANG =
  process.env.OPENAI_MODEL_LANG || process.env.OPENAI_MODEL || "gpt-4o-mini";

// ============================
// Helpers
// ============================

function extractReplyFromResponse(resp) {
  // Responses API
  if (resp?.output_text) return String(resp.output_text || "").trim();

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

  // Chat Completions fallback (احتياط)
  if (resp?.choices?.[0]?.message?.content) {
    return String(resp.choices[0].message.content || "").trim();
  }

  return "";
}

function buildSystemInstruction(lang, mode = "doctor") {
  const L = lang || "auto";

  // Doctor Mode (افتراضي)
  if (mode === "doctor") {
    return `
You are FixLens Doctor — a world-class mechanic doctor for vehicles.
You must always reply in the user's language (${L}).
If language is "auto", detect the user's language from their latest message and reply in that same language.

Use "white language": neutral, professional, globally understandable.
No slang, no regional dialects, no Iraqi tone, no street tone, no academic tone.

Output rules:
- Write ONE single professional report as normal paragraphs.
- No headings, no bullet points, no numbering.
- Start strong like an expert mechanic, but do not claim certainty.
- Use likelihood wording (likely / possible / less likely).
- If information is missing, ask ONLY 2–3 targeted questions inside the same report (not as a list).
`.trim();
  }

  // Normal mode (لو احتجته لاحقاً)
  return `
You are FixLens Auto — a professional vehicle diagnostic assistant.
Always reply in the user's language (${L || "auto"}).
Use white language, and keep the reply as one report with no headings and no bullet points.
`.trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) return `data:${safeMime};base64,${b64}`;

  // fallback sniff
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8)
    return `data:image/jpeg;base64,${b64}`;
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50)
    return `data:image/png;base64,${b64}`;
  if (buffer.length > 4 && buffer.toString("ascii", 0, 4) === "RIFF")
    return `data:image/webp;base64,${b64}`;
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
  ffmpeg.setFfmpegPath(ffmpegPath);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-ac", "1", "-ar", "16000", "-vn", "-f", "wav"])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });
}

// ============================
// Language (ALL languages)
// ============================
const _langCache = new Map();

function _normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase();
  // BCP-47 basic validator: en, ar, hi, fr, pt-br, zh-hant, ...
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c)) return null;
  return c;
}

async function detectLanguageWithAI(text) {
  const sample = (text || "").trim();
  if (sample.length < 2) return null;

  const key = sample.slice(0, 140);
  if (_langCache.has(key)) return _langCache.get(key);

  try {
    const resp = await openai.responses.create({
      model: MODEL_LANG,
      temperature: 0,
      max_output_tokens: 20,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                `Detect the language of the text and return ONLY a BCP-47 language tag (examples: en, ar, hi, fr, es, de, pt-BR). If mixed, return dominant.\n\nTEXT:\n${key}`,
            },
          ],
        },
      ],
    });

    const out = (extractReplyFromResponse(resp) || "").trim().split(/\s+/)[0];
    const lang = _normalizeLang(out) || null;
    _langCache.set(key, lang);
    return lang;
  } catch {
    return null;
  }
}

async function resolveLanguage({ preferredLanguage, message, transcriptText }) {
  const p = _normalizeLang(preferredLanguage);
  if (p) return p;

  const fromMsg = await detectLanguageWithAI(message);
  if (fromMsg) return fromMsg;

  const fromTranscript = await detectLanguageWithAI(transcriptText);
  if (fromTranscript) return fromTranscript;

  return "auto";
}

// ============================
// WAV Decoder (بدون مكتبة خارجية)
// ============================
function decodeWavToMonoFloat32(buffer) {
  if (
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Not a valid WAV (RIFF/WAVE missing)");
  }

  let offset = 12;
  let fmt = null;
  let dataChunk = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + size;

    if (id === "fmt ") {
      const audioFormat = buffer.readUInt16LE(chunkStart + 0); // 1 PCM, 3 IEEE float
      const numChannels = buffer.readUInt16LE(chunkStart + 2);
      const sampleRate = buffer.readUInt32LE(chunkStart + 4);
      const bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
      fmt = { audioFormat, numChannels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      dataChunk = buffer.slice(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (size % 2);
  }

  if (!fmt) throw new Error("WAV fmt chunk not found");
  if (!dataChunk) throw new Error("WAV data chunk not found");

  const { audioFormat, numChannels, sampleRate, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isFinite(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error("Invalid bitsPerSample in WAV");
  }

  const frameSize = bytesPerSample * numChannels;
  const frames = Math.floor(dataChunk.length / frameSize);
  const mono = new Float32Array(frames);

  if (audioFormat === 1 && bitsPerSample === 16) {
    let p = 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        const s = dataChunk.readInt16LE(p + c * 2);
        sum += s / 32768;
      }
      mono[i] = sum / numChannels;
      p += frameSize;
    }
  } else if (audioFormat === 3 && bitsPerSample === 32) {
    let p = 0;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < numChannels; c++) {
        sum += dataChunk.readFloatLE(p + c * 4);
      }
      mono[i] = sum / numChannels;
      p += frameSize;
    }
  } else {
    throw new Error(
      `Unsupported WAV format: audioFormat=${audioFormat}, bits=${bitsPerSample}, channels=${numChannels}`
    );
  }

  return { sampleRate, channelData: mono };
}

// ============================
// Audio signal analysis
// ============================
function _clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function _rms(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, arr.length));
}

function _zeroCrossRate(arr) {
  let z = 0;
  for (let i = 1; i < arr.length; i++) {
    if ((arr[i - 1] >= 0 && arr[i] < 0) || (arr[i - 1] < 0 && arr[i] >= 0))
      z++;
  }
  return z / Math.max(1, arr.length);
}

// naive DFT for small window only
function _dftMag(signal) {
  const N = signal.length;
  const mags = new Float64Array(Math.floor(N / 2));
  for (let k = 0; k < mags.length; k++) {
    let re = 0,
      im = 0;
    for (let n = 0; n < N; n++) {
      const ang = (2 * Math.PI * k * n) / N;
      re += signal[n] * Math.cos(ang);
      im -= signal[n] * Math.sin(ang);
    }
    mags[k] = Math.sqrt(re * re + im * im);
  }
  return mags;
}

function _bandEnergy(mags, sampleRate, fftSize, f1, f2) {
  const binHz = sampleRate / fftSize;
  const k1 = Math.max(0, Math.floor(f1 / binHz));
  const k2 = Math.min(mags.length - 1, Math.floor(f2 / binHz));
  let s = 0;
  for (let k = k1; k <= k2; k++) s += mags[k] * mags[k];
  return s;
}

function _peakImpulseRate(signal, sampleRate) {
  const abs = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) abs[i] = Math.abs(signal[i]);

  const window = Math.max(1, Math.floor(sampleRate * 0.01)); // 10ms
  const env = new Float64Array(abs.length);
  let acc = 0;
  for (let i = 0; i < abs.length; i++) {
    acc += abs[i];
    if (i >= window) acc -= abs[i - window];
    env[i] = acc / window;
  }

  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= Math.max(1, env.length);

  const thr = mean * 2.8;
  let peaks = 0;
  let lastPeak = -1e9;
  const minGap = Math.floor(sampleRate * 0.03);

  for (let i = 0; i < env.length; i++) {
    if (env[i] > thr && i - lastPeak > minGap) {
      peaks++;
      lastPeak = i;
    }
  }

  const seconds = env.length / sampleRate;
  return peaks / Math.max(0.1, seconds);
}

async function analyzeWavFeatures(wavPath) {
  const buf = fs.readFileSync(wavPath);
  const audio = decodeWavToMonoFloat32(buf);

  const sampleRate = audio.sampleRate || 16000;
  const ch = audio.channelData;
  if (!ch || !ch.length) return { ok: false, reason: "empty_wav" };

  const maxSamples = Math.min(ch.length, sampleRate * 10);
  const data = ch.slice(0, maxSamples);

  const rms = _rms(data);
  const zcr = _zeroCrossRate(data);
  const durationSec = data.length / sampleRate;

  const fftSize = Math.min(2048, data.length);
  const windowData = data.slice(0, fftSize);
  const mags = _dftMag(windowData);

  const eLow = _bandEnergy(mags, sampleRate, fftSize, 20, 160);
  const eMid = _bandEnergy(mags, sampleRate, fftSize, 160, 1000);
  const eHigh = _bandEnergy(mags, sampleRate, fftSize, 1000, 6000);
  const eTotal = eLow + eMid + eHigh + 1e-12;

  const lowRatio = eLow / eTotal;
  const midRatio = eMid / eTotal;
  const highRatio = eHigh / eTotal;

  const impulseRate = _peakImpulseRate(data, sampleRate);

  const knockScore = _clamp01(
    (impulseRate / 8.0) * 0.55 + highRatio * 0.3 + midRatio * 0.15
  );

  let texture = "unknown";
  if (knockScore > 0.72) texture = "sharp_impulsive";
  else if (lowRatio > 0.55 && impulseRate < 2.2) texture = "low_rumble";
  else if (highRatio > 0.45 && impulseRate < 2.5) texture = "hissy_whine";
  else texture = "mixed_noise";

  return {
    ok: true,
    sampleRate,
    durationSec: Number(durationSec.toFixed(2)),
    rms: Number(rms.toFixed(5)),
    zcr: Number(zcr.toFixed(5)),
    bandRatio: {
      low: Number(lowRatio.toFixed(3)),
      mid: Number(midRatio.toFixed(3)),
      high: Number(highRatio.toFixed(3)),
    },
    impulseRatePerSec: Number(impulseRate.toFixed(2)),
    knockScore: Number(knockScore.toFixed(2)),
    texture,
  };
}

// ============================
// TEXT
// ============================
export async function diagnoseText({
  message,
  preferredLanguage,
  vehicleInfo,
  mode = "doctor",
}) {
  if (!message || !message.trim()) {
    return {
      reply: "Please describe the problem first.",
      language: preferredLanguage || "auto",
    };
  }

  const lang = await resolveLanguage({ preferredLanguage, message });
  const issues = findRelevantIssues(message);

  const userPrompt = `
USER LANGUAGE: ${lang}

USER MESSAGE:
${message}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

Final rule: Reply strictly in "${lang}" using white language.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang, mode),
    input: [
      { role: "user", content: [{ type: "input_text", text: userPrompt }] },
    ],
    temperature: 0.28,
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
  mode = "doctor",
}) {
  const lang = await resolveLanguage({ preferredLanguage, message });
  const issues = findRelevantIssues((message || "").trim());
  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
USER LANGUAGE: ${lang}

Analyze the image and any context below.

CONTEXT:
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

Final rule: Reply strictly in "${lang}" using white language.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_VISION,
    instructions: buildSystemInstruction(lang, mode),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    temperature: 0.25,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
  };
}

// ============================
// AUDIO
// ============================
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  audioBuffer,
  audioMime,
  audioOriginalName,
  mode = "doctor",
}) {
  // حماية إضافية
  if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length < 200) {
    const lang = await resolveLanguage({ preferredLanguage, message });
    return {
      reply:
        lang === "ar"
          ? "لم يصلني ملف صوت صالح. رجاءً سجّل الصوت مرة أخرى لعدة ثوانٍ وأرسله من جديد."
          : "I didn’t receive a valid audio file. Please record again for a few seconds and try sending it.",
      language: lang,
      transcript: null,
    };
  }

  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpIn = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const tmpWav = path.join(
    os.tmpdir(),
    `fixlens_audio_${Date.now()}_16k_mono.wav`
  );

  fs.writeFileSync(tmpIn, audioBuffer);

  let transcriptText = "";
  let features = null;

  try {
    await convertToWav16kMono(tmpIn, tmpWav);

    try {
      features = await analyzeWavFeatures(tmpWav);
    } catch {
      features = { ok: false, reason: "feature_extract_failed" };
    }

    try {
      const transcription = await openai.audio.transcriptions.create({
        model: MODEL_TRANSCRIBE,
        file: fs.createReadStream(tmpWav),
      });
      transcriptText = (transcription?.text || "").trim();
    } catch {
      transcriptText = "";
    }
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }

  // ✅ هنا الحل: نكشف اللغة بعد ما نحصل transcriptText
  const lang = await resolveLanguage({
    preferredLanguage,
    message,
    transcriptText,
  });

  const issues = findRelevantIssues((message || "").trim());
  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;

  const userPrompt = `
USER LANGUAGE: ${lang}

You received an audio clip (engine/mechanical sounds are common).

TRANSCRIPTION (only if the user spoke; may be empty):
${transcriptText || "(no clear speech detected)"}

AUDIO SIGNAL FEATURES (derived from the waveform; use as clues, not certainty):
${JSON.stringify(features || { ok: false, reason: "no_features" }, null, 2)}

CONTEXT (user typed message, may be empty):
${(message || "").trim() || "(no text provided)"}

${vehicleInfo ? `VEHICLE INFO:\n${vehicleInfo}\n` : ""}

Relevant issues from internal database (if any):
${JSON.stringify(issues || [], null, 2)}

Rules:
- Do NOT pretend you recognized an exact part from sound alone.
- Use features as hints (impulsive vs rumble vs whine) combined with context.
- Ask ONLY 2–3 targeted questions inside the same report (not a list).
- Reply strictly in "${lang}" using white language.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildSystemInstruction(lang, mode),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.22,
  });

  return {
    reply: extractReplyFromResponse(resp) || "No reply generated.",
    language: lang,
    transcript: transcriptLooksEmpty ? null : transcriptText,
  };
}
