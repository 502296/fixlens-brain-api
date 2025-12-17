// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

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
// GLOBAL SYSTEM PROMPT (KEEP STYLE)
// ============================
const SYSTEM_PROMPT_GLOBAL = `
You are FixLens Doctor Mechanic: a senior heavy-duty vehicle diagnostic expert.
Speak like an experienced mechanic explaining to a customer.

Absolute rules (must follow):
- Reply in the user's language only (the same language the user wrote in).
- Do not switch languages under any condition.
- Output MUST be ONE single paragraph only (no line breaks).
- No headings, no bullet points, no numbering.
- Do not repeat the same idea in different wording.
- Keep it calm, confident, practical, and globally understandable ("white language").
- Avoid academic tone and avoid slang.
- Do not ask questions.
- Prioritize the most likely root cause(s) first, then the safest next action(s).
- If safety risk exists, mention it naturally without panic.
- Use internal database matches as primary evidence when relevant.
`.trim();

// ============================
// Models
// ============================
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
const MODEL_LANG =
  process.env.OPENAI_MODEL_LANG || process.env.OPENAI_MODEL || "gpt-4o-mini";

// ============================
// DataHub (load /data/*.json + cache)
// ============================
let _dataCache = null;

function loadDataHub() {
  if (_dataCache) return _dataCache;

  const dataDir = path.join(process.cwd(), "data");
  const exists = fs.existsSync(dataDir);

  const files = exists
    ? fs.readdirSync(dataDir).filter((f) => f.toLowerCase().endsWith(".json"))
    : [];

  const byFile = {};
  for (const f of files) {
    const full = path.join(dataDir, f);
    try {
      const raw = fs.readFileSync(full, "utf8");
      byFile[f] = JSON.parse(raw);
      if (!Array.isArray(byFile[f])) byFile[f] = [];
    } catch (e) {
      console.error("DATA JSON ERROR:", f, e?.message || String(e));
      byFile[f] = [];
    }
  }

  _dataCache = {
    ok: true,
    dataDir,
    files,
    byFile,
    totalItems: Object.values(byFile).reduce(
      (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
      0
    ),
  };

  return _dataCache;
}

export function getDataHealth() {
  const hub = loadDataHub();
  return {
    ok: true,
    dataDir: hub.dataDir,
    files: hub.files.length,
    totalItems: hub.totalItems,
    sampleFiles: hub.files.slice(0, 8),
  };
}

// ============================
// Helpers
// ============================
function extractReplyFromResponse(resp) {
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

  if (resp?.choices?.[0]?.message?.content) {
    return String(resp.choices[0].message.content || "").trim();
  }

  return "";
}

// force one-paragraph output (no line breaks)
function enforceSingleParagraph(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  return t.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

function bufferToDataUrl(buffer, mime) {
  const safeMime = (mime || "").toLowerCase();
  const b64 = buffer.toString("base64");

  if (safeMime.startsWith("image/")) return `data:${safeMime};base64,${b64}`;

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

/**
 * ✅ NEW (IMPORTANT):
 * We always prefer the language DETECTED from the user's actual content,
 * so FixLens replies in the same language the user wrote in,
 * even if preferredLanguage was incorrectly sent as "en".
 */
async function resolveLanguage({ preferredLanguage, message, transcriptText }) {
  const pref = _normalizeLang(preferredLanguage);
  const msg = (message || "").trim();
  const tr = (transcriptText || "").trim();

  // 1) Detect from user's typed message first (strongest signal)
  const fromMsg = await detectLanguageAsyncSafe(msg);
  if (fromMsg) return fromMsg;

  // 2) Then from transcript (audio)
  const fromTranscript = await detectLanguageAsyncSafe(tr);
  if (fromTranscript) return fromTranscript;

  // 3) If preferredLanguage is provided and not empty, use it
  if (pref) return pref;

  // 4) Final fallback
  return "en";
}

async function detectLanguageAsyncSafe(text) {
  const t = (text || "").trim();
  if (t.length < 2) return null;
  return await detectLanguageWithAI(t);
}

// ============================
// WAV Decoder + audio features (as-is)
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
      const audioFormat = buffer.readUInt16LE(chunkStart + 0);
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
    if ((arr[i - 1] >= 0 && arr[i] < 0) || (arr[i - 1] < 0 && arr[i] >= 0)) z++;
  }
  return z / Math.max(1, arr.length);
}

function _dftMag(signal) {
  const N = signal.length;
  const mags = new Float64Array(Math.floor(N / 2));
  for (let k = 0; k < mags.length; k++) {
    let re = 0, im = 0;
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

  const window = Math.max(1, Math.floor(sampleRate * 0.01));
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
// Relevant issues matching (from /data/*.json)
// ============================
function _normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _tokens(s) {
  const t = _normalizeText(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean);
}

function _scoreIssue(msgTokens, issue) {
  const pats = []
    .concat(issue?.symptom_patterns || [])
    .concat(issue?.keywords || [])
    .concat(issue?.patterns || [])
    .filter(Boolean)
    .map(String);

  const short = String(issue?.symptom_short || issue?.title || issue?.name || "");
  const extra = [short].filter(Boolean);

  const all = pats.concat(extra).map(_normalizeText).filter(Boolean);
  if (!all.length) return 0;

  let score = 0;
  const msg = msgTokens.join(" ");

  for (const p of all) {
    if (!p) continue;
    if (msg.includes(p)) score += Math.min(6, 2 + Math.floor(p.split(" ").length / 2));
  }

  const issueTokens = new Set(_tokens(all.join(" ")));
  let overlap = 0;
  for (const tok of msgTokens) if (issueTokens.has(tok)) overlap++;
  score += Math.min(6, overlap * 0.6);

  return score;
}

function findRelevantIssuesFromData(message) {
  const hub = loadDataHub();
  const msgTokens = _tokens(message || "");
  if (!msgTokens.length) return [];

  const results = [];

  for (const file of hub.files) {
    const arr = hub.byFile[file] || [];
    for (const issue of arr) {
      const s = _scoreIssue(msgTokens, issue);
      if (s > 0.9) {
        results.push({
          score: Number(s.toFixed(2)),
          source: file,
          ...issue,
        });
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 7);
}

// ============================
// Doctor Mechanic System Prompt (strict)
// ============================
function buildDoctorMechanicInstruction(lang) {
  const L = lang || "en";
  return `
${SYSTEM_PROMPT_GLOBAL}

User language: ${L}. Reply ONLY in this language.

Extra output constraints (very important):
- The entire answer must be a SINGLE paragraph with no line breaks at all.
- Target length: 4 to 7 sentences (avoid long explanations).
- Avoid repeating the same recommendation twice.
- If internal database matches are empty or irrelevant, do not force them.

Audio rule:
- If audio speech is unclear, do not guess speech content; use waveform features as clues and give a smart fallback message without questions.
`.trim();
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
      language: preferredLanguage || "en",
    };
  }

  const lang = await resolveLanguage({ preferredLanguage, message });
  const issues = findRelevantIssuesFromData(message);

  const userPrompt = `
Language=${lang}. User message: ${(message || "").trim()} ${
    vehicleInfo ? ` Vehicle info: ${String(vehicleInfo).trim()}` : ""
  } Internal matches JSON: ${JSON.stringify(issues || [])}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.15,
    max_output_tokens: 260,
  });

  const raw = extractReplyFromResponse(resp) || "No reply generated.";
  return {
    reply: enforceSingleParagraph(raw),
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
  const issues = findRelevantIssuesFromData((message || "").trim());
  const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

  const userPrompt = `
Language=${lang}. Context text: ${((message || "").trim() || "(no text provided)")} ${
    vehicleInfo ? ` Vehicle info: ${String(vehicleInfo).trim()}` : ""
  } Internal matches JSON: ${JSON.stringify(issues || [])}. Analyze the image carefully and respond using the rules.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_VISION,
    instructions: buildDoctorMechanicInstruction(lang),
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: userPrompt },
          { type: "input_image", image_url: imageDataUrl },
        ],
      },
    ],
    temperature: 0.15,
    max_output_tokens: 300,
  });

  const raw = extractReplyFromResponse(resp) || "No reply generated.";
  return {
    reply: enforceSingleParagraph(raw),
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
  if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length < 200) {
    const lang = await resolveLanguage({ preferredLanguage, message });
    const reply =
      lang === "ar"
        ? "لم يصلني ملف صوت صالح. سجّل المقطع من جديد لمدة 6 إلى 10 ثوانٍ، وقرّب الهاتف من مصدر الصوت قدر الإمكان، ثم أعد الإرسال."
        : "I didn’t receive a valid audio file. Record again for 6–10 seconds, get closer to the sound source, and resend.";
    return { reply, language: lang, transcript: null };
  }

  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpIn = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}_16k_mono.wav`);

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

  const lang = await resolveLanguage({
    preferredLanguage,
    message,
    transcriptText,
  });

  const issues = findRelevantIssuesFromData((message || "").trim());
  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;

  const userPrompt = `
Language=${lang}. Transcript=${transcriptText || "(no clear speech detected)"} FeaturesJSON=${JSON.stringify(
    features || { ok: false, reason: "no_features" }
  )} TypedContext=${((message || "").trim() || "(no text provided)")} ${
    vehicleInfo ? ` VehicleInfo=${String(vehicleInfo).trim()}` : ""
  } InternalMatchesJSON=${JSON.stringify(issues || [])}. Remember: do not invent speech if transcript is empty; use features as hints; single paragraph only.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.15,
    max_output_tokens: 320,
  });

  const raw = extractReplyFromResponse(resp) || "No reply generated.";
  return {
    reply: enforceSingleParagraph(raw),
    language: lang,
    transcript: transcriptLooksEmpty ? null : transcriptText,
  };
}
