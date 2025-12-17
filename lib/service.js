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
// GLOBAL SYSTEM PROMPT (UPDATED)
// ============================
const SYSTEM_PROMPT_GLOBAL = `
You are FixLens Doctor Mechanic: a senior heavy-duty vehicle diagnostic expert.
Speak like an experienced mechanic explaining to a customer.

Absolute rules (must follow):
- Reply in the user's language only.
- Keep it calm, confident, practical, and globally understandable ("white language").
- Avoid academic tone and avoid slang.
- Do not ask questions.
- Do not repeat the same idea in different wording.
- Prioritize the most likely root cause(s) first, then the safest next action(s).
- If safety risk exists, mention it naturally without panic.
- Use internal database matches as primary evidence when relevant.

Formatting rules:
- Default: 1 short paragraph (3–6 sentences).
- If listing multiple causes or steps would improve clarity, use up to 4 bullet lines starting with "•".
- No headings like "Summary / Causes / Next steps".
- Keep it concise; avoid long explanations.

Audio rules:
- If transcript is empty or unclear, do NOT invent speech content.
- Use waveform features as clues to analyze mechanical sound types (knock/whine/rattle/rumble) and provide practical next actions.
- If audio is too weak for analysis, give a short localized fallback message in the user's language (no questions).
`.trim();

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
  if (t.length > 1400) t = t.slice(0, 1400).trim();
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
// Localized fallback (NO questions)
// ============================
function localizedAudioFallback(lang) {
  const L = (lang || "en").toLowerCase();

  if (L.startsWith("ar"))
    return "الصوت لم يكن واضحاً بما يكفي للتحليل. سجّل 6 إلى 10 ثوانٍ وقرّب الهاتف من مصدر الصوت قدر الإمكان، وتجنّب الهواء القوي حول المايكروفون.";
  if (L.startsWith("tr"))
    return "Ses analiz için yeterince net değildi. 6–10 saniye kaydedin, telefonu ses kaynağına yaklaştırın ve mikrofonu rüzgârdan koruyun.";
  if (L.startsWith("ja"))
    return "音声が分析に十分なほど明瞭ではありませんでした。6〜10秒ほど録音し、音源に近づけて、風でマイクが当たらないようにしてください。";
  if (L.startsWith("ko"))
    return "오디오가 분석하기에 충분히 선명하지 않았습니다. 6–10초 정도 다시 녹음하고, 소리 나는 곳에 더 가까이 대고, 바람 소음을 피해주세요.";
  if (L.startsWith("zh"))
    return "音频不够清晰，无法可靠分析。请录制6–10秒，并尽量靠近声音来源，同时避免强风噪声。";
  if (L.startsWith("es"))
    return "El audio no fue lo bastante claro para analizarlo. Graba 6–10 segundos, acércate a la fuente del sonido y evita el ruido del viento en el micrófono.";
  if (L.startsWith("fr"))
    return "Le son n’était pas assez clair pour une analyse fiable. Enregistrez 6–10 secondes, rapprochez-vous de la source et évitez le bruit du vent sur le micro.";
  if (L.startsWith("de"))
    return "Das Audio war nicht klar genug für eine zuverlässige Analyse. Nimm 6–10 Sekunden auf, geh näher an die Geräuschquelle und vermeide Windgeräusche am Mikrofon.";
  if (L.startsWith("pt"))
    return "O áudio não estava claro o suficiente para analisar. Grave 6–10 segundos, chegue mais perto da fonte do som e evite ruído de vento no microfone.";
  if (L.startsWith("ru"))
    return "Аудио было недостаточно чистым для анализа. Запишите 6–10 секунд, поднесите телефон ближе к источнику звука и избегайте шума ветра у микрофона.";

  return "The audio was not clear enough to analyze reliably. Record 6–10 seconds, move closer to the sound source, and avoid wind noise on the microphone.";
}

// ============================
// Language (ALL languages)
// ============================
const _langCache = new Map();

function _normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim().toLowerCase();
  if (c === "auto") return "auto";
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
              text: `Detect the language of the text and return ONLY a BCP-47 language tag (examples: en, ar, hi, fr, es, de, pt-BR). If mixed, return dominant.\n\nTEXT:\n${key}`,
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
  if (p && p !== "auto") return p;

  const fromMsg = await detectLanguageWithAI(message);
  if (fromMsg) return fromMsg;

  const fromTranscript = await detectLanguageWithAI(transcriptText);
  if (fromTranscript) return fromTranscript;

  return "auto";
}

// ============================
// WAV Decoder + audio features
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
// Doctor Mechanic Instruction
// ============================
function buildDoctorMechanicInstruction(lang) {
  const L = lang || "auto";
  return `
${SYSTEM_PROMPT_GLOBAL}

User language: ${L}. If language is "auto", detect from the user's latest content and reply in that language.

Extra constraints:
- Target length: short and helpful (avoid long explanations).
- Prefer 3–6 sentences total, OR up to 4 bullets if listing is clearer.
- If internal database matches are empty or irrelevant, do not force them.
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
    const lang = _normalizeLang(preferredLanguage) || "en";
    const reply =
      lang.startsWith("ar")
        ? "صف لي المشكلة التي تواجهها في السيارة."
        : "Please describe the problem first.";
    return { reply, language: lang };
  }

  const lang = await resolveLanguage({ preferredLanguage, message });
  const issues = findRelevantIssuesFromData(message);

  const userPrompt = `
Language=${lang}. User message: ${(message || "").trim()}${
    vehicleInfo ? ` Vehicle info: ${String(vehicleInfo).trim()}` : ""
  }
Internal matches JSON: ${JSON.stringify(issues || [])}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.15,
    max_output_tokens: 240,
  });

  const raw = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply: normalizeOutput(raw), language: lang };
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
Language=${lang}.
Context text: ${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `Vehicle info: ${String(vehicleInfo).trim()}` : ""}
Internal matches JSON: ${JSON.stringify(issues || [])}.
Analyze the image carefully and respond using the rules.
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
    max_output_tokens: 260,
  });

  const raw = extractReplyFromResponse(resp) || "No reply generated.";
  return { reply: normalizeOutput(raw), language: lang };
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
  // Validate file
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

  const lang = await resolveLanguage({
    preferredLanguage,
    message,
    transcriptText,
  });

  const issues = findRelevantIssuesFromData((message || "").trim());

  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 8;
  const featuresTooWeak =
    !features ||
    features.ok !== true ||
    (typeof features.rms === "number" && features.rms < 0.002);

  // ✅ NEW: If transcript empty AND features too weak → localized fallback in user's language
  if (transcriptLooksEmpty && featuresTooWeak) {
    return { reply: localizedAudioFallback(lang), language: lang, transcript: null };
  }

  // ✅ If transcript empty but features exist → still diagnose based on waveform features
  const userPrompt = `
Language=${lang}.
Transcript=${transcriptLooksEmpty ? "(no clear speech detected)" : transcriptText}
AudioFeaturesJSON=${JSON.stringify(features)}
TypedContext=${((message || "").trim() || "(no text provided)")}
${vehicleInfo ? `VehicleInfo=${String(vehicleInfo).trim()}` : ""}
InternalMatchesJSON=${JSON.stringify(issues || [])}

Important:
- Do not invent speech if transcript is empty.
- Use AudioFeaturesJSON + TypedContext to diagnose the mechanical sound.
- Keep it short and practical. No questions.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstruction(lang),
    input: [{ role: "user", content: [{ type: "input_text", text: userPrompt }] }],
    temperature: 0.15,
    max_output_tokens: 260,
  });

  const raw = extractReplyFromResponse(resp) || localizedAudioFallback(lang);
  return {
    reply: normalizeOutput(raw),
    language: lang,
    transcript: transcriptLooksEmpty ? null : transcriptText,
  };
}
