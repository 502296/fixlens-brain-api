// lib/service.js
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

// ✅ doctorPrompt.js عندك يصدر: export const doctorPrompt = `...`
import { doctorPrompt as DOCTOR_PRO_PROMPT } from "./doctorPrompt.js";

// ============================
// ✅ Safe OpenAI Client (NO CRASH)
// ============================
function getApiKey() {
  return (
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_KEY ||
    process.env.OPENAI_TOKEN ||
    ""
  ).trim();
}

function getOpenAIClientOrNull() {
  const apiKey = getApiKey();
  if (!apiKey) return null;
  try {
    return new OpenAI({ apiKey });
  } catch {
    return null;
  }
}

// ============================
// ✅ Models (LOCKED STRATEGY)
// Text => GPT-5.1
// Vision => GPT-4o
// Audio transcript => whisper-1
// Lang detect/translate => gpt-4o-mini (fast)
// ============================
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-5.1";

const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION || process.env.OPENAI_MODEL || "gpt-4o";

const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "whisper-1";

const MODEL_LANG =
  process.env.OPENAI_MODEL_LANG || process.env.OPENAI_MODEL || "gpt-4o-mini";

// ============================
// ✅ Doctor Pro Prompt (locked language)
// ============================
function buildDoctorMechanicProPrompt(langLocked) {
  const L = String(langLocked || "en").trim();

  return `
${String(DOCTOR_PRO_PROMPT || "").trim()}

ABSOLUTE OVERRIDE:
- Output ONLY in the user's language: "${L}". No other language.
- Never switch language mid-session.
- Speak like a senior diagnostic technician: precise, calm, confident.
- Do not use headings or bullet points unless user explicitly asks for them.
`.trim();
}

// ============================
// ✅ DataHub (load /data/*.json + cache)
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
// ✅ Helpers (robust extraction)
// ============================
function extractReplyAny(resp) {
  // Chat Completions shape
  if (resp?.choices?.[0]?.message?.content) {
    return String(resp.choices[0].message.content || "").trim();
  }

  // Responses API shape
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

  return "";
}

function normalizeOutput(text) {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.replace(/\r\n/g, "\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > 9000) t = t.slice(0, 9000).trim();
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

// ============================
// ✅ Safe OpenAI wrappers (NO crash)
// ============================

// Responses API (vision, lang tasks)
async function safeResponsesCreate(openai, payload, { timeoutMs = 120000 } = {}) {
  if (!openai) return { __error: "missing_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await openai.responses.create({
      ...payload,
      signal: controller.signal,
    });
    return resp;
  } catch (e) {
    return { __error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Chat Completions (TEXT model GPT-5.1)
async function safeChatCompletionsCreate(openai, payload, { timeoutMs = 120000 } = {}) {
  if (!openai) return { __error: "missing_key" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await openai.chat.completions.create({
      ...payload,
      signal: controller.signal,
    });
    return resp;
  } catch (e) {
    return { __error: e?.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ✅ TEXT strategy: try chat.completions first (best for GPT-5.1), fallback to responses
async function safeTextCreate(openai, { model, system, user, temperature, maxTokens }) {
  // 1) chat.completions
  const c = await safeChatCompletionsCreate(
    openai,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    },
    { timeoutMs: 120000 }
  );

  if (!c?.__error && extractReplyAny(c)) return c;

  // 2) fallback responses (if available for that model)
  const r = await safeResponsesCreate(
    openai,
    {
      model,
      instructions: system,
      input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
      temperature,
      max_output_tokens: maxTokens,
    },
    { timeoutMs: 120000 }
  );

  return r;
}

// ============================
// ✅ Language (BCP-47) + caches
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

async function detectLanguageWithAI(openai, text) {
  const sample = (text || "").trim();
  if (sample.length < 2) return null;

  const key = sample.slice(0, 160);
  if (_langCache.has(key)) return _langCache.get(key);

  const resp = await safeResponsesCreate(
    openai,
    {
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
    },
    { timeoutMs: 30000 }
  );

  if (resp?.__error) return null;

  const out = (extractReplyAny(resp) || "").trim().split(/\s+/)[0];
  const lang = _normalizeLang(out) || null;
  _langCache.set(key, lang);
  return lang;
}

// ✅ LOCK LANGUAGE: if preferredLanguage provided (and not auto), ALWAYS use it.
async function resolveLanguage(openai, { preferredLanguage, message, transcriptText }) {
  const p = _normalizeLang(preferredLanguage);
  if (p && p !== "auto") return p;

  const fromMsg = await detectLanguageWithAI(openai, message);
  if (fromMsg && fromMsg !== "auto") return fromMsg;

  const fromTranscript = await detectLanguageWithAI(openai, transcriptText);
  if (fromTranscript && fromTranscript !== "auto") return fromTranscript;

  return "en";
}

async function translateToTargetLanguage(openai, text, targetLang) {
  const t = String(text || "").trim();
  if (!t) return "";

  const target = _normalizeLang(targetLang);
  if (!target || target === "auto") return t;

  const resp = await safeResponsesCreate(
    openai,
    {
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
    },
    { timeoutMs: 45000 }
  );

  if (resp?.__error) return t;
  return normalizeOutput(extractReplyAny(resp) || t);
}

async function enforceLanguage(openai, outputText, targetLang) {
  const out = String(outputText || "").trim();
  if (!out) return out;

  const target = _normalizeLang(targetLang) || "en";
  const detected = await detectLanguageWithAI(openai, out);
  if (!detected) return out;

  if (_primaryLang(detected) === _primaryLang(target)) return out;
  return await translateToTargetLanguage(openai, out, target);
}

// ============================
// ✅ Conversation History (NO server storage)
// ============================
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const cleaned = [];
  for (const m of history) {
    if (!m) continue;
    const role = String(m.role || m.sender || "").toLowerCase();
    const text = String(m.text || m.content || m.message || "").trim();
    if (!text) continue;
    if (role !== "user" && role !== "assistant") continue;
    cleaned.push({ role, text });
  }
  return cleaned.slice(-10); // last 10 only
}

function formatHistoryForPrompt(history) {
  const h = normalizeHistory(history);
  if (!h.length) return "(empty)";
  return h
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
}

// ============================
// ✅ Depth + Pricing Guard
// ============================
function _countWords(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function _hasAny(text, arr) {
  const t = String(text || "").toLowerCase();
  return arr.some((k) => t.includes(String(k).toLowerCase()));
}

function decideReportDepth({ message, vehicleInfo, transcriptText, audioFeatures }) {
  const m = String(message || "");
  const v = String(vehicleInfo || "");
  const tr = String(transcriptText || "");
  const textAll = `${m}\n${v}\n${tr}`.toLowerCase();
  const words = _countWords(textAll);

  const heavy = _hasAny(textAll, [
    "semi","truck","tractor","freightliner","cascadia","volvo","kenworth","peterbilt",
    "international","mack","isx","dd15","cummins","detroit","j1939","j1708",
    "cpc","sam","derate","regen","dpf","def","aftertreatment","ecm","tcm","abs",
    "can","transmission","gear","no crank","crank no start",
    "شاحنة","سيمي","فريتلانر","كاسكاديا","ريجن","دف","ديزل","tcm","ecu","can"
  ]);

  const ghostElectrical = _hasAny(textAll, [
    "intermittent","random","sometimes","comes and goes","after bump","rough road","vibration",
    "cuts out","drops","flicker","screen","dash","cluster","modules","communication",
    "u0","lost comm","low voltage","ground","grounds","battery","alternator","charging",
    "يروح ويجي","يفصل","تقطيع","مطبات","ترج","أرضي","دينمو","بطارية","فولتية","شحن"
  ]);

  const safety = _hasAny(textAll, [
    "oil pressure","overheat","smoke","brake","steering","fuel leak","stall",
    "knocking","metal knock","loss of power",
    "ضغط زيت","حرارة","دخان","فرامل","ستيرنغ","تسريب وقود","يطفي","طرق","ضعف عزم"
  ]);

  const audioComplex =
    audioFeatures && audioFeatures.ok === true
      ? (audioFeatures.knockScore >= 0.55 ||
         audioFeatures.impulseRatePerSec >= 3.5 ||
         (audioFeatures.bandRatio && audioFeatures.bandRatio.high >= 0.35))
      : false;

  if (heavy || ghostElectrical || audioComplex) return "deep";
  if (safety) return "normal";
  if (words >= 55) return "normal";
  return "short";
}

function depthGuidance(depth) {
  if (depth === "deep") {
    return `
ProfessionalDepth=DEEP
- Cover the problem end-to-end like a senior diagnostic technician.
- Focus on isolation logic, not listing.
- Include only checks that materially change the diagnostic direction.
- Stop once the fault path is clear.
`.trim();
  }
  if (depth === "short") {
    return `
ProfessionalDepth=SHORT
- Keep the report tight and decisive.
- State the most likely causes and the fastest confirm/deny checks.
- Avoid background explanation.
`.trim();
  }
  return `
ProfessionalDepth=NORMAL
- Provide a complete but efficient diagnostic path.
- Balance clarity with brevity.
- Avoid unnecessary detail once the direction is clear.
`.trim();
}

function wantsPricing(message) {
  const t = String(message || "").toLowerCase();
  return _hasAny(t, [
    "price","prices","cost","estimate","how much","pricing","labor rate",
    "سعر","اسعار","كم يكلف","تكلفة","تقدير","ميزانية","شكد"
  ]);
}

function pricingGuardText(lang, allowPricing) {
  if (allowPricing) return "";
  const L = String(lang || "en").toLowerCase();
  if (L.startsWith("ar")) {
    return `
NoPricingRule:
- لا تذكر أي أسعار أو تقديرات أو نصائح شراء قطع إلا إذا سأل المستخدم عن السعر صراحةً.
`.trim();
  }
  return `
NoPricingRule:
- Do NOT mention repair costs, price ranges, parts shopping suggestions, or labor estimates unless the user explicitly asks.
`.trim();
}

// ============================
// ✅ Audio helpers
// ============================
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
  if (!ffmpegPath) throw new Error("ffmpeg-static not available in this environment.");
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
// ✅ WAV decode + features (same logic)
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
// ✅ Relevant issues matching (from /data/*.json)
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
// ✅ Localized fallback
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

function missingKeyReply(lang) {
  const L = String(lang || "en").toLowerCase();
  if (L.startsWith("ar")) {
    return "FixLens Brain غير مفعّل لأن مفتاح OpenAI غير موجود على السيرفر. أضف OPENAI_API_KEY داخل Railway Variables ثم أعد التشغيل.";
  }
  return "FixLens Brain is not active because the OpenAI key is missing on the server. Add OPENAI_API_KEY in Railway Variables and restart.";
}

// ============================
// ✅ STAGE 2 — Consent Gate (NO STORAGE SERVER-SIDE)
// ============================
function isRepairRequest(message = "") {
  const m = String(message || "").toLowerCase();
  return [
    // Arabic
    "كيف اصلح","كيف أصلح","اصلح","أصلح","تصليح","صلّح","خطوات",
    "كيف اغير","كيف أغير","اغير","أغير","بدّل","تبديل","استبدال",
    "تفكيك","تركيب","فك","ركّب",
    // English
    "how to fix","how to repair","how to replace","replace","repair","fix",
    "change","install","remove","diy","step by step"
  ].some(k => m.includes(k));
}

function consentRequiredResponse(lang = "en") {
  const L = String(lang || "en").toLowerCase();
  if (L.startsWith("ar")) {
    return {
      ok: false,
      requiresConsent: true,
      language: lang,
      reply:
        "قبل أن أشرح أي خطوات تصليح، أحتاج تأكيد بسيط:\n\n" +
        "▪️ تفهم أن الإرشادات عامة وليست بديلاً عن فني مختص\n" +
        "▪️ لديك أدوات السلامة الأساسية وتعرف متى تتوقف\n" +
        "▪️ تتحمل مسؤولية التنفيذ\n\n" +
        "هل ترغب بالمتابعة؟",
    };
  }

  return {
    ok: false,
    requiresConsent: true,
    language: lang,
    reply:
      "Before I give any repair steps, I need a quick confirmation:\n\n" +
      "▪️ You understand this is general guidance, not a substitute for a professional\n" +
      "▪️ You have proper safety equipment and know when to stop\n" +
      "▪️ You take responsibility for performing the work\n\n" +
      "Do you want to continue?",
  };
}

// ============================
// ✅ TEXT
// ============================
export async function diagnoseText({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  mode = "doctor",
  consentGranted = false, // ✅ Stage 2
}) {
  const openai = getOpenAIClientOrNull();

  const langPre = _normalizeLang(preferredLanguage) || "en";

  // ✅ CONSENT GATE (Stage 2)
  if (isRepairRequest(message) && !consentGranted) {
    const lang = langPre === "auto" ? "en" : langPre;
    return consentRequiredResponse(lang);
  }

  if (!openai) {
    const lang = langPre === "auto" ? "en" : langPre;
    return { reply: missingKeyReply(lang), language: lang, ok: false };
  }

  try {
    if (!message || !String(message).trim()) {
      const lang = langPre === "auto" ? "en" : langPre;
      const reply = lang.startsWith("ar")
        ? "1) اكتب وصف المشكلة التي تواجهها في السيارة.\n2) هل تريد DIY خطوة بخطوة أم تشخيص ورشة/OBD؟"
        : "1) Describe the problem you have.\n2) Do you want DIY step-by-step or shop/OBD diagnosis?";
      return { reply, language: lang, ok: true };
    }

    const lang = await resolveLanguage(openai, { preferredLanguage, message });

    // ✅ CONSENT GATE (Stage 2) after auto language resolve
    if (isRepairRequest(message) && !consentGranted) {
      return consentRequiredResponse(lang);
    }

    const issues = findRelevantIssuesFromData(message);

    const depth = decideReportDepth({ message, vehicleInfo, transcriptText: "" });
    const allowPricing = wantsPricing(message);
    const historyText = formatHistoryForPrompt(history);

    const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

UserMessage=${String(message || "").trim()}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

${depthGuidance(depth)}
${pricingGuardText(lang, allowPricing)}

BehaviorGuidance:
- Use ConversationHistory as the source of truth for already-provided info (year/make/model/symptoms).
- NEVER ask for year/make/model if it already exists in ConversationHistory.
- If you must ask a clarifying question, ask ONLY ONE question at the end.
- Avoid repetition. Each line must add NEW information.
- Do NOT mention prices unless the user asks.
`.trim();

    const maxTokens = depth === "deep" ? 1800 : 1300;

    // ✅ GPT-5.1 via chat.completions (fallback to responses if needed)
    const resp = await safeTextCreate(openai, {
      model: MODEL_TEXT,
      system: buildDoctorMechanicProPrompt(lang),
      user: userPrompt,
      temperature: 0.25,
      maxTokens,
    });

    if (resp?.__error) {
      const fallback = lang.startsWith("ar")
        ? "صار خطأ مؤقت في السيرفر. جرّب مرة ثانية بعد لحظات."
        : "A temporary server error occurred. Please try again in a moment.";
      return { reply: fallback, language: lang, ok: false, details: resp.__error };
    }

    const raw = extractReplyAny(resp) || "";
    const normalized = normalizeOutput(raw).replace(/\n{3,}/g, "\n\n").trim();
    const fixed = await enforceLanguage(openai, normalized, lang);

    return { reply: fixed, language: lang, ok: true };
  } catch (err) {
    console.error("diagnoseText error:", err);
    const lang = langPre === "auto" ? "en" : langPre;
    const fallback = lang.startsWith("ar")
      ? "صار خطأ غير متوقع. جرّب مرة ثانية."
      : "An unexpected error occurred. Please try again.";
    return { reply: fallback, language: lang, ok: false, details: err?.message || String(err) };
  }
}

// ============================
// ✅ IMAGE (GPT-4o via Responses Vision)
// ============================
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  imageBuffer,
  imageMime,
  mode = "doctor",
  consentGranted = false, // ✅ Stage 2
}) {
  const openai = getOpenAIClientOrNull();
  const langPre = _normalizeLang(preferredLanguage) || "en";
  if (!openai) {
    const lang = langPre === "auto" ? "en" : langPre;
    return { reply: missingKeyReply(lang), language: lang, ok: false };
  }

  try {
    const lang = await resolveLanguage(openai, { preferredLanguage, message });

    // ✅ CONSENT GATE (Stage 2)
    if (isRepairRequest(message) && !consentGranted) {
      return consentRequiredResponse(lang);
    }

    const issues = findRelevantIssuesFromData((message || "").trim());
    const imageDataUrl = bufferToDataUrl(imageBuffer, imageMime);

    const depth = decideReportDepth({ message, vehicleInfo, transcriptText: "" });
    const allowPricing = wantsPricing(message);
    const historyText = formatHistoryForPrompt(history);

    const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

ContextText=${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

${depthGuidance(depth)}
${pricingGuardText(lang, allowPricing)}

BehaviorGuidance:
- Use ConversationHistory as the source of truth for already-provided info.
- NEVER ask for info that already exists in ConversationHistory.
- Be flexible: short when simple, deeper when complex.
- Avoid repetition. Each line must add NEW information.
- Use the photo as evidence; do not invent details.
- End with ONE question only.
`.trim();

    const maxTokens = depth === "deep" ? 1800 : 1300;

    const resp = await safeResponsesCreate(openai, {
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
      max_output_tokens: maxTokens,
    });

    if (resp?.__error) {
      const fallback = lang.startsWith("ar")
        ? "صار خطأ مؤقت في تحليل الصورة. جرّب مرة ثانية."
        : "A temporary image analysis error occurred. Please try again.";
      return { reply: fallback, language: lang, ok: false, details: resp.__error };
    }

    const raw = extractReplyAny(resp) || "";
    const normalized = normalizeOutput(raw).replace(/\n{3,}/g, "\n\n").trim();
    const fixed = await enforceLanguage(openai, normalized, lang);

    return { reply: fixed, language: lang, ok: true };
  } catch (err) {
    console.error("diagnoseImage error:", err);
    const lang = langPre === "auto" ? "en" : langPre;
    const fallback = lang.startsWith("ar")
      ? "صار خطأ غير متوقع في تحليل الصورة."
      : "An unexpected error occurred while analyzing the image.";
    return { reply: fallback, language: lang, ok: false, details: err?.message || String(err) };
  }
}

// ============================
// ✅ AUDIO (transcribe whisper-1, report GPT-5.1)
// ============================
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  audioBuffer,
  audioMime,
  audioOriginalName,
  mode = "doctor",
  consentGranted = false, // ✅ Stage 2
}) {
  const openai = getOpenAIClientOrNull();
  const langPre = _normalizeLang(preferredLanguage) || "en";

  if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length < 200) {
    const lang = openai
      ? await resolveLanguage(openai, { preferredLanguage, message })
      : (langPre === "auto" ? "en" : langPre);
    return { reply: localizedAudioFallback(lang), language: lang, transcript: null, ok: false };
  }

  if (!openai) {
    const lang = langPre === "auto" ? "en" : langPre;
    return { reply: missingKeyReply(lang), language: lang, transcript: null, ok: false };
  }

  let transcriptText = "";
  let features = { ok: false, reason: "no_features" };

  const ext = extFromAudioMimeOrName(audioMime, audioOriginalName);
  const tmpIn = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
  const tmpWav = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}_16k_mono.wav`);

  try {
    fs.writeFileSync(tmpIn, audioBuffer);

    try {
      await convertToWav16kMono(tmpIn, tmpWav);
    } catch (e) {
      const lang = await resolveLanguage(openai, { preferredLanguage, message });

      // ✅ CONSENT GATE even if convert failed? keep normal audio fallback
      return {
        reply: localizedAudioFallback(lang),
        language: lang,
        transcript: null,
        ok: false,
        details: e?.message || String(e),
      };
    }

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
  } catch (err) {
    console.error("audio pipeline error:", err);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }

  try {
    const lang = await resolveLanguage(openai, { preferredLanguage, message, transcriptText });

    // ✅ CONSENT GATE (Stage 2)
    if (isRepairRequest(message) && !consentGranted) {
      return consentRequiredResponse(lang);
    }

    const issues = findRelevantIssuesFromData((message || "").trim());

    const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;
    const featuresTooWeak =
      !features ||
      features.ok !== true ||
      (typeof features.rms === "number" && features.rms < 0.002);

    if (transcriptLooksEmpty && featuresTooWeak) {
      return { reply: localizedAudioFallback(lang), language: lang, transcript: null, ok: false };
    }

    const depth = decideReportDepth({
      message,
      vehicleInfo,
      transcriptText,
      audioFeatures: features,
    });

    const allowPricing = wantsPricing(message);
    const historyText = formatHistoryForPrompt(history);

    const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

Transcript=${transcriptLooksEmpty ? "(no clear speech detected)" : transcriptText}
AudioFeaturesJSON=${JSON.stringify(features)}
TypedContext=${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

${depthGuidance(depth)}
${pricingGuardText(lang, allowPricing)}

Important:
- Use ConversationHistory as the source of truth for already-provided info.
- NEVER ask for info that already exists in ConversationHistory.
- If transcript is empty, do NOT invent speech.
- Use AudioFeaturesJSON + TypedContext to diagnose the mechanical sound.
- Avoid repetition. Each line must add NEW information.
- End with ONE question only.
`.trim();

    const maxTokens = depth === "deep" ? 1800 : 1300;

    // ✅ Final audio report uses GPT-5.1 text model (chat.completions w/ fallback)
    const resp = await safeTextCreate(openai, {
      model: MODEL_TEXT,
      system: buildDoctorMechanicProPrompt(lang),
      user: userPrompt,
      temperature: 0.25,
      maxTokens,
    });

    if (resp?.__error) {
      const fallback = localizedAudioFallback(lang);
      return { reply: fallback, language: lang, transcript: null, ok: false, details: resp.__error };
    }

    const raw = extractReplyAny(resp) || localizedAudioFallback(lang);
    const normalized = normalizeOutput(raw).replace(/\n{3,}/g, "\n\n").trim();
    const fixed = await enforceLanguage(openai, normalized, lang);

    return {
      reply: fixed,
      language: lang,
      transcript: transcriptLooksEmpty ? null : transcriptText,
      ok: true,
    };
  } catch (err) {
    console.error("diagnoseAudio error:", err);
    const lang = langPre === "auto" ? "en" : langPre;
    return {
      reply: localizedAudioFallback(lang),
      language: lang,
      transcript: null,
      ok: false,
      details: err?.message || String(err),
    };
  }
}
