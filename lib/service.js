// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// ✅ Doctor Pro Prompt (external file)
import { DOCTOR_PRO_PROMPT } from "./doctorPrompt.js";

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
// ✅ FIXLENS DOCTOR MECHANIC – PRO PROMPT (from doctorPrompt.js)
// ============================
function buildDoctorMechanicProPrompt(langLocked) {
  const L = String(langLocked || "en").trim();

  // We rely on the external Doctor Pro prompt, but we lock language here.
  // If your DOCTOR_PRO_PROMPT already includes language locking, this is still safe.
  return `
${DOCTOR_PRO_PROMPT}

ABSOLUTE OVERRIDE:
- Output ONLY in the user's language: "${L}". No other language.
`.trim();
}

// ============================
// Models
// ============================
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o-mini";
const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";
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

function normalizeOutput(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.replace(/\r\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > 7000) t = t.slice(0, 7000).trim(); // allow longer pro reports if needed
  return t;
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
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static not available in this environment.");
  }
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
// Language (BCP-47)
// ============================
const _langCache = new Map();

function _normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase();
  if (!c) return null;
  if (c === "auto") return "auto";
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c)) return null;
  return c;
}

function _primaryLang(tag) {
  const t = String(tag || "").toLowerCase().trim();
  if (!t) return null;
  return t.split("-")[0];
}

async function detectLanguageWithAI(text) {
  const sample = (text || "").trim();
  if (sample.length < 2) return null;

  const key = sample.slice(0, 160);
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
                "Detect the language of the text and return ONLY a BCP-47 language tag " +
                "(examples: en, ar, hi, fr, es, de, pt-BR). If mixed, return dominant.\n\nTEXT:\n" +
                key,
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

// Never return "auto" outward — always lock to a real language.
async function resolveLanguage({ preferredLanguage, message, transcriptText }) {
  const p = _normalizeLang(preferredLanguage);

  if (p && p !== "auto") return p;

  const fromMsg = await detectLanguageWithAI(message);
  if (fromMsg && fromMsg !== "auto") return fromMsg;

  const fromTranscript = await detectLanguageWithAI(transcriptText);
  if (fromTranscript && fromTranscript !== "auto") return fromTranscript;

  return "en";
}

async function translateToTargetLanguage(text, targetLang) {
  const t = String(text || "").trim();
  if (!t) return "";

  const target = _normalizeLang(targetLang);
  if (!target || target === "auto") return t;

  const resp = await openai.responses.create({
    model: MODEL_LANG,
    temperature: 0,
    max_output_tokens: 900,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `Translate the following text to ${target}.\n` +
              `Keep the SAME style and numbering. Do NOT add headings.\n` +
              `Return ONLY the translated text.\n\nTEXT:\n${t}`,
          },
        ],
      },
    ],
  });

  return normalizeOutput(extractReplyFromResponse(resp) || t);
}

async function enforceLanguage(outputText, targetLang) {
  const out = String(outputText || "").trim();
  if (!out) return out;

  const target = _normalizeLang(targetLang) || "en";
  const detected = await detectLanguageWithAI(out);
  if (!detected) return out;

  if (_primaryLang(detected) === _primaryLang(target)) return out;
  return await translateToTargetLanguage(out, target);
}

// ============================
// WAV Decoder + audio features (unchanged)
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

function _clamp01(x) { return Math.max(0, Math.min(1, x)); }
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
// Localized fallback (WITH one final question)
// ============================
function localizedAudioFallback(lang) {
  const L = String(lang || "en").toLowerCase();

  if (L.startsWith("ar"))
    return (
      "1) الصوت لم يكن واضحاً بما يكفي للتحليل.\n" +
      "2) سجّل 6 إلى 10 ثوانٍ وقرّب الهاتف من مصدر الصوت قدر الإمكان وتجنب الهواء على المايك.\n" +
      "3) إذا الصوت يظهر فقط عند الدعس/التعشيق/اللفة، اذكر متى يظهر بالضبط.\n" +
      "4) هل تريدني أمشي وياك DIY خطوة بخطوة لو تفضّل تشخيص ورشة/OBD؟"
    );

  return (
    "1) The audio was not clear enough to analyze reliably.\n" +
    "2) Record 6–10 seconds, move closer to the sound source, and avoid wind noise on the mic.\n" +
    "3) If it happens only on acceleration/gear change/turning, tell me exactly when it happens.\n" +
    "4) Do you want DIY step-by-step, or shop/OBD diagnosis?"
  );
}

// ============================
// TEXT
// ============================
export async function diagnoseText({ message, preferredLanguage, vehicleInfo, mode = "doctor" }) {
  if (!message || !message.trim()) {
    const lang = _normalizeLang(preferredLanguage) || "en";
    const reply = lang.startsWith("ar")
      ? "1) اكتب وصف المشكلة التي تواجهها في السيارة.\n2) هل تريد DIY خطوة بخطوة أم تشخيص ورشة/OBD؟"
      : "1) Describe the problem you have.\n2) Do you want DIY step-by-step or shop/OBD diagnosis?";
    return { reply, language: lang === "auto" ? "en" : lang };
  }

  const lang = await resolveLanguage({ preferredLanguage, message });
  const issues = findRelevantIssuesFromData(message);

  // ✅ Add region/localization hint, but DO NOT force prices or shop lists unless needed.
  const userPrompt = `
UserLanguage=${lang}
UserMessage=${(message || "").trim()}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

BehaviorGuidance:
- Be flexible: short when simple, detailed when complex.
- Do NOT focus on prices unless the user asks; you may ask what kind of help they want (DIY vs shop vs exact estimate).
- If location is needed for shops/junkyards, ask ONE location question (city/state/country) inside the final single question.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicProPrompt(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.25,
    max_output_tokens: 1100,
  });

  const raw = extractReplyFromResponse(resp) || "";
  const fixed = await enforceLanguage(normalizeOutput(raw), lang);

  return { reply: fixed, language: lang };
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
UserLanguage=${lang}
ContextText=${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

BehaviorGuidance:
- Be flexible: short when simple, detailed when complex.
- Do NOT focus on prices unless the user asks.
- Use the photo as evidence; do not invent details.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_VISION,
    instructions: buildDoctorMechanicProPrompt(lang),
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
    max_output_tokens: 1100,
  });

  const raw = extractReplyFromResponse(resp) || "";
  const fixed = await enforceLanguage(normalizeOutput(raw), lang);

  return { reply: fixed, language: lang };
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
    return { reply: localizedAudioFallback(lang), language: lang, transcript: null };
  }

  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpIn = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}_16k_mono.wav`);

  fs.writeFileSync(tmpIn, audioBuffer);

  let transcriptText = "";
  let features = { ok: false, reason: "no_features" };

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

  const lang = await resolveLanguage({ preferredLanguage, message, transcriptText });
  const issues = findRelevantIssuesFromData((message || "").trim());

  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;
  const featuresTooWeak =
    !features ||
    features.ok !== true ||
    (typeof features.rms === "number" && features.rms < 0.002);

  if (transcriptLooksEmpty && featuresTooWeak) {
    return { reply: localizedAudioFallback(lang), language: lang, transcript: null };
  }

  const userPrompt = `
UserLanguage=${lang}
Transcript=${transcriptLooksEmpty ? "(no clear speech detected)" : transcriptText}
AudioFeaturesJSON=${JSON.stringify(features)}
TypedContext=${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

Important:
- If transcript is empty, do NOT invent speech.
- Use AudioFeaturesJSON + TypedContext to diagnose the mechanical sound.
- Be flexible: short when simple, detailed when complex.
- Do NOT focus on prices unless the user asks.
- Output must follow Doctor Pro rules and end with ONE question only.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicProPrompt(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.25,
    max_output_tokens: 1100,
  });

  const raw = extractReplyFromResponse(resp) || localizedAudioFallback(lang);
  const fixed = await enforceLanguage(normalizeOutput(raw), lang);

  return {
    reply: fixed,
    language: lang,
    transcript: transcriptLooksEmpty ? null : transcriptText,
  };
}
