// service.js — FixLens Doctor Brain v4.0.0
// Goals:
// - Data-first diagnosis
// - Global multilingual replies with language lock from first user language
// - GPS + places support
// - Search only when needed
// - Clean Responses API flow
// - Safer audio transcription flow using supported json format

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL =
  process.env.FIXLENS_MODEL ||
  process.env.OPENAI_MODEL ||
  "gpt-4.1";

const TRANSCRIBE_MODEL =
  process.env.FIXLENS_TRANSCRIBE_MODEL ||
  "gpt-4o-mini-transcribe";

const DATA_DIR = path.join(process.cwd(), "data");
const VEHICLE_MAP_PATH = path.join(DATA_DIR, "vehicle_engine_map.json");
const ENGINE_PATTERNS_PATH = path.join(DATA_DIR, "engine_patterns.json");
const US_ENGINE_INTEL_PATH = path.join(DATA_DIR, "us_engine_intel_v1.json");

/* =========================================================
   LOAD DATA
========================================================= */
function safeLoadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

const VEHICLE_ENGINE_MAP = safeLoadJson(VEHICLE_MAP_PATH, []);
const ENGINE_PATTERNS = safeLoadJson(ENGINE_PATTERNS_PATH, []);
const US_ENGINE_INTEL = safeLoadJson(US_ENGINE_INTEL_PATH, {
  version: "0",
  scope: "",
  engines: [],
  patterns: [],
});

/* =========================================================
   BASICS
========================================================= */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

async function withRetry(fn, tries = 2, baseDelay = 250) {
  let lastError;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn(i);
    } catch (error) {
      lastError = error;
      await sleep(baseDelay * (i + 1));
    }
  }
  throw lastError;
}

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUserLocation(raw) {
  if (!raw) return null;

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value || value.toLowerCase() === "global") return null;
    return value;
  }

  if (isObject(raw)) {
    const lat = Number(raw.lat ?? raw.latitude);
    const lng = Number(raw.lng ?? raw.longitude ?? raw.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }

    const label = String(raw.label || raw.address || raw.name || "").trim();
    if (label) return label;
  }

  return null;
}

function pickUserLocation(body = {}) {
  return (
    normalizeUserLocation(body.user_location) ||
    normalizeUserLocation(body.location) ||
    normalizeUserLocation(body.gps) ||
    normalizeUserLocation(body.latlng) ||
    null
  );
}

function hasLatLng(location) {
  return (
    isObject(location) &&
    Number.isFinite(Number(location.lat)) &&
    Number.isFinite(Number(location.lng))
  );
}

/* =========================================================
   LANGUAGE LOCK
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  if (/[\u0900-\u097F]/.test(t)) return "hi";
  if (/[\u0E00-\u0E7F]/.test(t)) return "th";
  if (/[\u00C0-\u024F]/.test(t)) return "fr";
  if (/[äöüß]/i.test(t)) return "de";
  if (/[áéíóúñ¿¡]/i.test(t)) return "es";
  if (/[ãõç]/i.test(t)) return "pt";
  return "en";
}

function normalizeLocale(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value || value === "auto") return "";
  return value;
}

function inferLockedLocale({ locale, text, history = [] }) {
  const explicit = normalizeLocale(locale);
  if (explicit) return explicit;

  // lock to the first meaningful user message language
  for (const item of history) {
    if (item?.role !== "user") continue;
    const content = String(item?.content || "").trim();
    if (!content) continue;
    return detectTextLanguage(content);
  }

  return detectTextLanguage(text || "") || "en";
}

function isArabic(locale = "") {
  return String(locale || "").toLowerCase().startsWith("ar");
}

/* =========================================================
   VEHICLE / ENGINE INTEL
========================================================= */
function extractVehicleInfo(text = "") {
  const normalized = normalizeToken(text);

  const yearMatch = normalized.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  let make = null;
  let model = null;

  for (const row of VEHICLE_ENGINE_MAP) {
    const mk = normalizeToken(row?.make);
    const md = normalizeToken(row?.model);

    if (mk && normalized.includes(mk)) make = row.make;

    const normalizedLoose = normalized.replace(/-/g, "");
    const mdLoose = md.replace(/-/g, "");
    if (md && (normalized.includes(md) || normalizedLoose.includes(mdLoose))) {
      model = row.model;
    }

    if (make && model) break;
  }

  return { make, model, year };
}

function detectEngineFromVehicle(make, model, year) {
  if (!make || !model || !Number.isFinite(year)) return null;

  const mk = normalizeToken(make);
  const md = normalizeToken(model);

  const found = VEHICLE_ENGINE_MAP.find((row) => {
    const rowMake = normalizeToken(row?.make);
    const rowModel = normalizeToken(row?.model);
    const years = Array.isArray(row?.year_range) ? row.year_range : [];
    const y0 = Number(years[0]);
    const y1 = Number(years[1]);

    if (!rowMake || !rowModel || !Number.isFinite(y0) || !Number.isFinite(y1)) {
      return false;
    }

    const sameMake = rowMake === mk;
    const sameModel =
      rowModel === md ||
      rowModel.replace(/-/g, "") === md.replace(/-/g, "");

    return sameMake && sameModel && year >= y0 && year <= y1;
  });

  if (!found || !Array.isArray(found.engines) || found.engines.length === 0) {
    return null;
  }

  return String(found.engines[0] || "").trim() || null;
}

function findSimpleEngineIssues(engineName = "") {
  const name = String(engineName || "").trim().toLowerCase();
  if (!name) return [];

  const hit = ENGINE_PATTERNS.find(
    (item) => String(item?.engine || "").trim().toLowerCase() === name
  );

  return Array.isArray(hit?.issues) ? hit.issues.slice(0, 6) : [];
}

function matchSimpleEngineIssuesToText(issues = [], text = "") {
  const normalized = normalizeToken(text);

  return (Array.isArray(issues) ? issues : [])
    .map((issue) => {
      const keywords = Array.isArray(issue?.keywords) ? issue.keywords : [];
      let score = 0;

      for (const keyword of keywords) {
        const k = normalizeToken(keyword);
        if (k && normalized.includes(k)) score += 1;
      }

      return { ...issue, __score: score };
    })
    .filter((item) => Number(item.__score || 0) >= 1)
    .sort((a, b) => (b.__score || 0) - (a.__score || 0))
    .slice(0, 3);
}

function findIntelEnginesForVehicle(make, model, year) {
  const mk = normalizeToken(make);
  const md = normalizeToken(model);
  const yy = Number(year);

  if (!mk || !md || !Number.isFinite(yy)) return [];

  const engines = Array.isArray(US_ENGINE_INTEL?.engines)
    ? US_ENGINE_INTEL.engines
    : [];

  return engines
    .filter((engine) => {
      const makes = Array.isArray(engine?.makes) ? engine.makes : [];
      const models = Array.isArray(engine?.models) ? engine.models : [];
      const years = Array.isArray(engine?.years) ? engine.years : [];

      const makeOk = makes.some((m) => normalizeToken(m) === mk);
      const modelOk = models.some((m) => normalizeToken(m) === md);
      const yearOk = years.some((y) => Number(y) === yy);

      return makeOk && modelOk && yearOk;
    })
    .slice(0, 3);
}

function getIntelPatternByKey(key = "") {
  const target = String(key || "").trim();
  if (!target) return null;

  const patterns = Array.isArray(US_ENGINE_INTEL?.patterns)
    ? US_ENGINE_INTEL.patterns
    : [];

  return patterns.find(
    (pattern) => String(pattern?.pattern_key || "").trim() === target
  ) || null;
}

function scoreIntelPattern(pattern, text = "") {
  if (!pattern) return 0;

  const normalized = normalizeToken(text);
  const when = pattern?.when || {};
  const symptomKeywords = Array.isArray(when?.symptom_keywords_any)
    ? when.symptom_keywords_any
    : [];
  const extraClues = Array.isArray(when?.extra_clues_any)
    ? when.extra_clues_any
    : [];

  let score = 0;

  for (const keyword of symptomKeywords) {
    const k = normalizeToken(keyword);
    if (k && normalized.includes(k)) score += 2;
  }

  for (const keyword of extraClues) {
    const k = normalizeToken(keyword);
    if (k && normalized.includes(k)) score += 1;
  }

  return score;
}

function matchBestIntelPatternForEngine(engine, text = "") {
  if (!engine) return { pattern: null, score: 0 };

  const commonPatterns = Array.isArray(engine?.common_patterns)
    ? engine.common_patterns
    : [];

  if (commonPatterns.length === 0) return { pattern: null, score: 0 };

  let best = { pattern: null, score: 0 };

  for (const key of commonPatterns) {
    const pattern = getIntelPatternByKey(key);
    const score = scoreIntelPattern(pattern, text);
    if (score > best.score) best = { pattern, score };
  }

  if (best.score < 2) return { pattern: null, score: best.score };
  return best;
}

function buildEnginePack(userText = "") {
  const vehicle = extractVehicleInfo(userText);
  const detectedEngineName = detectEngineFromVehicle(
    vehicle.make,
    vehicle.model,
    vehicle.year
  );

  const simpleIssues = detectedEngineName
    ? findSimpleEngineIssues(detectedEngineName)
    : [];
  const simpleMatches = matchSimpleEngineIssuesToText(simpleIssues, userText);

  const candidateEngines = findIntelEnginesForVehicle(
    vehicle.make,
    vehicle.model,
    vehicle.year
  );

  let bestIntel = { engine: null, pattern: null, score: 0 };

  for (const engine of candidateEngines) {
    const match = matchBestIntelPatternForEngine(engine, userText);
    if (match.pattern && match.score > bestIntel.score) {
      bestIntel = { engine, pattern: match.pattern, score: match.score };
    }
  }

  return {
    vehicle,
    detected_engine_name: detectedEngineName || null,
    simple_engine_issue_matches: simpleMatches,
    intel_engine_candidate_count: candidateEngines.length,
    intel_best_engine: bestIntel.engine,
    intel_best_pattern: bestIntel.pattern,
    intel_score: bestIntel.score,
  };
}

function hasStrongInternalIntel(enginePack = {}) {
  const simpleCount = Array.isArray(enginePack?.simple_engine_issue_matches)
    ? enginePack.simple_engine_issue_matches.length
    : 0;

  const intelPattern = Boolean(enginePack?.intel_best_pattern);
  const intelScore = Number(enginePack?.intel_score || 0);

  if (intelPattern && intelScore >= 2) return true;
  if (simpleCount >= 2) return true;
  if (simpleCount >= 1 && enginePack?.detected_engine_name) return true;

  return false;
}

function buildEngineContextText(enginePack = {}) {
  return `
ENGINE_CONTEXT:
VEHICLE_MENTION=${JSON.stringify(enginePack?.vehicle || {})}
DETECTED_ENGINE_NAME=${JSON.stringify(enginePack?.detected_engine_name || null)}
SIMPLE_ENGINE_MATCHES=${JSON.stringify(enginePack?.simple_engine_issue_matches || [])}
INTEL_ENGINE=${JSON.stringify(enginePack?.intel_best_engine || null)}
INTEL_PATTERN=${JSON.stringify(enginePack?.intel_best_pattern || null)}

RULES:
- Use this only to sharpen diagnosis.
- Prefer internal data before external search.
- Never invent engine details not present above.
`.trim();
}

/* =========================================================
   INTENT
========================================================= */
function looksLikeDiagnosisText(input = "") {
  const t = String(input || "").toLowerCase();

  const words = [
    "noise", "sound", "rattle", "knock", "ticking", "click", "clunk",
    "grind", "squeal", "vibration", "shake", "misfire", "stall",
    "idle", "engine", "brake", "steering", "overheat", "smoke",
    "leak", "check engine", "p0", "code", "codes",

    "صوت", "طقطقة", "طرطقة", "تك تك", "نق", "خبط", "خشخشة", "صرير",
    "رجفة", "اهتزاز", "هزة", "تقطيع", "تنتيع", "تفتفة", "محرك",
    "مكينة", "فرامل", "دركسون", "ستيرنغ", "حرارة", "سخونة", "دخان",
    "تهريب", "تسريب", "لمبة", "تشيك", "عطل", "كود", "اكواد"
  ];

  return words.some((word) => t.includes(word));
}

function looksLikeNearbyRequest(input = "") {
  const t = String(input || "").toLowerCase();

  const nearbyWords = [
    "near me", "nearby", "closest", "around me", "near",
    "اقرب", "أقرب", "بالقرب", "قريب", "قريبة", "حولي", "حوليّ", "جنبي", "يمي"
  ];

  return nearbyWords.some((word) => t.includes(word));
}

function looksLikeShopOrPartsWords(input = "") {
  const t = String(input || "").toLowerCase();

  const words = [
    "mechanic", "garage", "auto repair", "repair shop", "car repair",
    "auto parts", "car parts", "parts store", "autozone", "o'reilly",
    "oreilly", "advance auto", "napa", "price", "prices", "cost",

    "ورشة", "ورش", "ورشة سيارات", "تصليح سيارات", "ميكانيكي", "ميكانيك",
    "كراج", "قطع غيار", "محل قطع", "محل قطع غيار", "سعر", "اسعار",
    "تكلفة", "بنشر", "اطارات", "إطارات", "كهربائي سيارات", "سمكري"
  ];

  return words.some((word) => t.includes(word));
}

function looksLikeMapWords(input = "") {
  const t = String(input || "").toLowerCase();

  const words = [
    "address", "location", "map", "google maps", "directions", "gps", "where",
    "عنوان", "موقع", "خرائط", "خريطة", "لوكيشن", "وين", "وينه", "دلني", "اشرلي"
  ];

  return words.some((word) => t.includes(word));
}

function looksLikePlacesRequest(input = "") {
  if (looksLikeNearbyRequest(input)) return true;
  if (looksLikeShopOrPartsWords(input)) return true;
  if (looksLikeMapWords(input) && looksLikeShopOrPartsWords(input)) return true;
  return false;
}

function getLastAssistantText(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") {
      return String(history[i]?.content || "");
    }
  }
  return "";
}

function looksLikePlacesFollowUp(history = []) {
  const lastAssistant = getLastAssistantText(history).toLowerCase();
  if (!lastAssistant) return false;

  const signals = [
    "gps",
    "enable location",
    "allow location",
    "zip",
    "zipcode",
    "postal",
    "area",
    "neighborhood",
    "district",
    "where are you",
    "فعّل gps",
    "فعل gps",
    "حدد موقعك",
    "اسم المنطقة",
    "اسم الحي",
    "اسم الشارع",
    "وين انت",
    "بالقرب"
  ];

  return signals.some((signal) => lastAssistant.includes(signal));
}

function looksLikeLocationOnlyText(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 80) return false;
  if (looksLikeDiagnosisText(t)) return false;
  if (looksLikePlacesRequest(t)) return false;
  return /^[\u0600-\u06FFa-zA-Z0-9\s\-\.,#]+$/.test(t);
}

/* =========================================================
   PLACES QUERY
========================================================= */
function inferPlacesCategory(text = "") {
  const t = String(text || "").toLowerCase();

  if (
    [
      "parts", "auto parts", "car parts", "parts store", "autozone", "o'reilly",
      "oreilly", "advance auto", "napa", "قطع", "قطع غيار", "محل قطع",
      "محل قطع غيار", "price", "prices"
    ].some((word) => t.includes(word))
  ) {
    return "auto parts store";
  }

  if (
    [
      "tire", "tyre", "tires", "tyres", "tire shop", "wheel", "alignment",
      "إطارات", "اطارات", "بنشر", "ميزان", "ترصيص"
    ].some((word) => t.includes(word))
  ) {
    return "tire shop";
  }

  if (
    [
      "brake", "brakes", "brake shop", "فرامل", "بريك", "هوبات", "سفايف"
    ].some((word) => t.includes(word))
  ) {
    return "brake shop";
  }

  if (
    [
      "auto electrician", "car electrician", "electrical", "starter",
      "alternator", "battery", "كهربائي سيارات", "كهرباء سيارات",
      "دينمو", "سلف", "بطارية"
    ].some((word) => t.includes(word))
  ) {
    return "auto electrical repair";
  }

  if (
    [
      "body shop", "collision", "paint", "dent", "panel", "سمكري", "صبغ", "دهان"
    ].some((word) => t.includes(word))
  ) {
    return "auto body shop";
  }

  return "auto repair shop";
}

function extractLocationHint(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const en = raw.match(/\b(?:in|near|around|at)\s+(.+)$/i);
  if (en?.[1]) return en[1].trim();

  const ar = raw.match(/(?:في|بـ|بالقرب\s+من|قريب\s+من|حول|جنب|يم)\s+(.+)$/i);
  if (ar?.[1]) return ar[1].trim();

  const zip = raw.match(/\b\d{4,10}\b/);
  if (zip?.[0]) return zip[0];

  return "";
}

function buildPlacesQuerySmart({
  userText = "",
  userLocation = null,
  placesFollowUp = false,
}) {
  const raw = String(userText || "").trim();
  const category = inferPlacesCategory(raw);

  if (hasLatLng(userLocation)) return category;

  const locationString =
    typeof userLocation === "string" && userLocation.trim()
      ? userLocation.trim()
      : "";

  if (placesFollowUp) {
    const followLocation = raw.length <= 80 ? raw : extractLocationHint(raw);
    const finalLocation = (followLocation || locationString || raw).trim();
    return finalLocation ? `${category} near ${finalLocation}` : category;
  }

  const hint = extractLocationHint(raw);
  const bestLocation = (hint || locationString || "").trim();
  if (bestLocation) return `${category} near ${bestLocation}`;

  return category;
}

/* =========================================================
   AUDIO
========================================================= */
function containsSmellWords(text = "") {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("smell") ||
    t.includes("burning") ||
    t.includes("plastic") ||
    t.includes("odor") ||
    t.includes("رائحة") ||
    t.includes("حرق") ||
    t.includes("بلاستيك")
  );
}

async function transcribeAudioSmart(audioBase64, locale, audioKind = "car_sound") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return {
      ok: false,
      text: "",
      audio_type: "none",
    };
  }

  const kind = String(audioKind || "car_sound").toLowerCase().trim();
  const isVoice = kind === "voice";
  const tempPath = path.join("/tmp", `fixlens_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: TRANSCRIBE_MODEL,
          response_format: "json",
          language: String(locale || "").split("-")[0] || undefined,
          prompt:
            "Audio may contain spoken automotive diagnosis or non-speech car sounds. If no spoken words are present, return an empty or very short transcript.",
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "transcription_timeout"
      )
    );

    const text = String(result?.text || "").trim();
    const looksLikeSpeech = /[a-zA-Z\u0600-\u06FF]{3,}/.test(text);

    if (!isVoice) {
      if (looksLikeSpeech && text.length <= 240) {
        return {
          ok: true,
          text,
          audio_type: "speech_detected_in_car_sound",
        };
      }

      return {
        ok: true,
        text: "",
        audio_type: "non_speech",
      };
    }

    if (!looksLikeSpeech || text.length > 320) {
      return {
        ok: true,
        text: "",
        audio_type: "non_speech",
      };
    }

    return {
      ok: true,
      text,
      audio_type: "speech",
    };
  } catch (error) {
    console.error("Audio Error:", error?.message || error);
    return {
      ok: false,
      text: "",
      audio_type: "error",
    };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/* =========================================================
   RESPONSES API HELPERS
========================================================= */
function tryJsonParse(input = "") {
  try {
    return JSON.parse(String(input || "").trim());
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = tryJsonParse(raw);
  if (direct) return direct;

  const fenced =
    raw.match(/```json\s*([\s\S]*?)```/i) ||
    raw.match(/```\s*([\s\S]*?)```/i);

  if (fenced?.[1]) {
    const parsed = tryJsonParse(fenced[1]);
    if (parsed) return parsed;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryJsonParse(raw.slice(start, end + 1));
    if (parsed) return parsed;
  }

  return null;
}

function getResponseText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const texts = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const chunk of content) {
      if (chunk?.type === "output_text" && chunk?.text) {
        texts.push(String(chunk.text));
      }
    }
  }

  return texts.join("\n").trim();
}

function historyItemToResponsesMessage(item) {
  const role = item?.role === "assistant" ? "assistant" : "user";
  const content = String(item?.content || "").trim();
  if (!content) return null;

  return {
    role,
    content: [{ type: "input_text", text: content }],
  };
}

function buildResponsesHistory(history = []) {
  return history
    .slice(-8)
    .map(historyItemToResponsesMessage)
    .filter(Boolean);
}

async function createDoctorResponse({
  history = [],
  userTextBlock = "",
  imageBase64 = "",
  extraUserInstruction = "",
  maxOutputTokens = 900,
  temperature = 0.2,
}) {
  const input = [
    ...buildResponsesHistory(history),
    {
      role: "user",
      content: [
        { type: "input_text", text: userTextBlock },
        ...(imageBase64
          ? [
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "high",
              },
            ]
          : []),
      ],
    },
  ];

  if (extraUserInstruction?.trim()) {
    input.push({
      role: "user",
      content: [{ type: "input_text", text: extraUserInstruction.trim() }],
    });
  }

  const response = await withRetry(() =>
    withTimeout(
      client.responses.create({
        model: CHAT_MODEL,
        instructions: buildDoctorSystemPrompt(),
        input,
        temperature,
        max_output_tokens: maxOutputTokens,
      }),
      Number(process.env.CHAT_TIMEOUT_MS || 25000),
      "responses_timeout"
    )
  );

  return {
    raw: response,
    text: getResponseText(response),
  };
}

/* =========================================================
   OUTPUT GUARDS
========================================================= */
function looksLikeRefusal(text = "") {
  const t = String(text || "").toLowerCase();

  return [
    "i can't assist",
    "i cannot assist",
    "i'm sorry, i can't",
    "i’m sorry, i can’t",
    "cannot help with that request",
    "can't help with that",
    "not able to help",
    "cannot comply",
    "i can't provide",
    "policy",
  ].some((phrase) => t.includes(phrase));
}

function violatesNoPlaces(reply = "") {
  const t = String(reply || "").toLowerCase();

  const blocked = [
    "zip", "zipcode", "postal", "postcode", "gps", "near me", "nearby", "closest",
    "google maps", "maps", "address", "location", "area", "neighborhood", "district",
    "city", "town", "where are you",
    "ورشة", "ورش", "ميكانيكي", "ميكانيك", "كراج", "خرائط", "خريطة", "لوكيشن",
    "عنوان", "حدد موقعك", "موقعك", "قريب", "اقرب", "أقرب", "منطقة", "حي", "مدينة"
  ];

  return blocked.some((word) => t.includes(word));
}

function safeFallbackReply(locale = "en") {
  if (isArabic(locale)) {
    return "وصلتني الأعراض أو المرفقات. أقوى الاحتمالات الآن هي misfire من البواجي أو الكويلات، أو خلل هواء ووقود مثل MAF أو البخاخات، أو دق حقيقي بسبب التوقيت أو الوقود. حتى أحددها أدق: هل لمبة Check Engine شغالة، وهل الصوت أقرب إلى تك تك سريع أم دق ثقيل؟";
  }

  return "I got your symptoms or attachments. The strongest possibilities right now are misfire from plugs or coils, an air-fuel issue like MAF or injectors, or true knock from timing or fuel. To narrow it down properly: is the Check Engine light on, and is the sound more like a fast tick or a deeper knock?";
}

/* =========================================================
   WORKSHOP FORMATTING
========================================================= */
function formatWorkshopsForContext(workshops = []) {
  return (Array.isArray(workshops) ? workshops : [])
    .slice(0, 6)
    .map((shop, index) => {
      const name = shop?.name || shop?.title || "Workshop";
      const address = shop?.address || shop?.formatted_address || shop?.vicinity || "";
      const phone = shop?.phone || shop?.formatted_phone_number || "";
      const rating = shop?.rating ? `rating:${shop.rating}` : "";
      const mapsUrl =
        shop?.maps_url ||
        shop?.google_maps_url ||
        shop?.googleMapsUri ||
        shop?.url ||
        "";
      const website = shop?.website || shop?.websiteUri || "";
      const price = shop?.price_hint || "";

      return `${index + 1}) ${[
        name,
        address,
        phone,
        rating,
        price,
        mapsUrl,
        website,
      ]
        .filter(Boolean)
        .join(" | ")}`;
    })
    .join("\n");
}

function formatWorkshopsForUser(workshops = [], locale = "en") {
  const arabic = isArabic(locale);

  return (Array.isArray(workshops) ? workshops : [])
    .slice(0, 5)
    .map((shop, index) => {
      const name = shop?.name || shop?.title || (arabic ? "ورشة" : "Shop");
      const address = shop?.address || shop?.formatted_address || shop?.vicinity || "";
      const phone = shop?.phone || shop?.formatted_phone_number || "";
      const mapsUrl =
        shop?.maps_url ||
        shop?.google_maps_url ||
        shop?.googleMapsUri ||
        shop?.url ||
        "";
      const price = shop?.price_hint || "";

      return [
        `${index + 1}) ${name}`,
        address ? (arabic ? `العنوان: ${address}` : `Address: ${address}`) : "",
        phone ? (arabic ? `هاتف: ${phone}` : `Phone: ${phone}`) : "",
        price || "",
        mapsUrl ? (arabic ? `خرائط: ${mapsUrl}` : `Maps: ${mapsUrl}`) : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/* =========================================================
   PROMPT BUILDERS
========================================================= */
function buildStrictContext({
  locale,
  userLocation,
  text,
  voiceText,
  includeVoiceText,
  audioAttached,
  audioKindFinal,
  audioType,
  placesIntent,
  engineContextText,
  verifiedData,
  verifiedWorkshops,
  internalIntelStrong,
}) {
  return `
STRICT_CONTEXT
LOCALE=${locale}
PLACES_INTENT=${placesIntent ? "true" : "false"}
LOCATION=${typeof userLocation === "string" ? userLocation : JSON.stringify(userLocation)}
DATA_FIRST_INTERNAL_INTEL_STRONG=${internalIntelStrong ? "true" : "false"}

ABSOLUTE_RULES:
- Reply in the locked user language only.
- Sound like a senior diagnostic mechanic.
- Lead with the strongest likely cause first.
- Use internal data first.
- If PLACES_INTENT=false, never ask for GPS, ZIP, city, maps, workshop, nearby shop, or location.
- No headings.
- No bullets.
- No numbering.
- Ask at most 2 questions only if they materially improve the next step.
- If safety critical, say so briefly and clearly.
- Be practical and causal.

${engineContextText}

VERIFIED_DATA_JSON=${JSON.stringify(verifiedData || [])}
VERIFIED_WORKSHOPS_JSON=${JSON.stringify(verifiedWorkshops || [])}
WORKSHOPS_CONTEXT_TEXT=
${formatWorkshopsForContext(verifiedWorkshops || [])}

AUDIO_ATTACHED=${audioAttached ? "true" : "false"}
AUDIO_KIND=${audioKindFinal || ""}
AUDIO_TYPE=${audioType || "none"}
AUDIO_TRANSCRIPT=${includeVoiceText ? voiceText : ""}

USER_INPUT=${text.trim()}
`.trim();
}

function buildStage1Instruction(locale = "en") {
  return `
Return ONLY valid JSON. No markdown. No code fences.

Required schema:
{
  "severity": "low|medium|high|urgent",
  "domain": "engine|transmission|cooling|brakes|steering|suspension|electrical|fuel|exhaust|ac|body|general",
  "likely_causes": ["string"],
  "must_ask": ["string"],
  "tests": ["string"],
  "risk": "string",
  "needs_search": true,
  "query": "string",
  "final_answer": "string"
}

Rules:
- likely_causes: 1 to 4 items, strongest first
- must_ask: 0 to 2 only
- tests: 1 to 5 practical checks
- needs_search=true only if verified external search materially improves the answer beyond internal data
- query="" unless needs_search=true
- final_answer must be in locale "${locale}"
- final_answer must sound like a trusted master mechanic
- final_answer must not contain headings, bullets, or numbering
- final_answer must ask max 2 questions only if truly needed
`.trim();
}

function buildRewriteInstruction(locale = "en") {
  return `
Rewrite the answer in locale "${locale}" as a real senior mechanic.

Rules:
- No headings
- No bullets
- No numbering
- No places/maps/GPS/location unless PLACES_INTENT=true
- Max 2 questions only if essential
- Calm, confident, practical
- Strongest likely cause first

Return only final answer text.
`.trim();
}

function buildRefineInstruction(locale = "en") {
  return `
Write ONLY the final answer in locale "${locale}".

Rules:
- Senior mechanic tone
- No headings
- No bullets
- No numbering
- No place or location talk unless PLACES_INTENT=true
- Max 2 questions only if essential
- Use verified data only to sharpen the next step
- Clear, practical, natural

Return only the answer text.
`.trim();
}

function shouldAllowExternalRefinement({ diag1, enginePack, placesIntent }) {
  if (placesIntent) return true;
  if (!diag1?.needs_search) return false;
  if (hasStrongInternalIntel(enginePack)) return false;
  return true;
}

/* =========================================================
   SEARCH HELPERS
========================================================= */
async function searchSmart({
  query,
  userLocation,
  locale,
  allowPlaces,
  placesRadiusMeters,
}) {
  return withRetry(() =>
    withTimeout(
      performSearch(query, userLocation, {
        locale,
        allowPlaces,
        placesRadiusMeters,
      }),
      Number(process.env.SEARCH_TIMEOUT_MS || 15000),
      "search_timeout"
    )
  );
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req?.body || {};
  const text = String(body.text || body.message || body.userText || "").trim();
  const history = Array.isArray(body.history) ? body.history : [];
  const imageBase64 = body.image_base_64 || body.image_base64 || "";
  const audioBase64 = body.audio_base_64 || body.audio_base64 || "";
  const audioKind = String(body.audio_kind || "").trim();
  const debugMode = Boolean(body.debug);

  const userLocation = pickUserLocation(body);
  const placesRadiusMeters = Number(
    body.places_radius_meters ||
      process.env.PLACES_RADIUS_METERS ||
      25000
  );

  let locale = inferLockedLocale({
    locale: body.locale,
    text,
    history,
  });

  try {
    if (!text && !imageBase64 && !audioBase64) {
      return {
        ok: false,
        reply: isArabic(locale)
          ? "اكتب الأعراض أو أرسل صورة أو صوت، وأنا أبدأ معك."
          : "Send symptoms or attach a photo or audio and I’ll start.",
        locale,
        workshops_count: 0,
        ...(debugMode ? { debug: { stage: "empty_input" } } : {}),
      };
    }

    // AUDIO
    const audioAttached = Boolean(audioBase64);
    const audioKindFinal = audioAttached ? (audioKind || "car_sound") : "";
    const audioResult = await transcribeAudioSmart(audioBase64, locale, audioKindFinal);

    let voiceText = audioResult.ok ? String(audioResult.text || "").trim() : "";
    const audioType = audioResult.audio_type || "none";

    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    const includeVoiceText =
      audioType === "speech" ||
      audioType === "speech_detected_in_car_sound";

    const fullInput = `${text} ${includeVoiceText ? voiceText : ""}`.trim();

    // Keep locale locked from first user language unless explicit locale was sent
    locale = inferLockedLocale({
      locale: body.locale || locale,
      text: fullInput || text,
      history,
    });

    // INTENT
    const diagnosisLikely = looksLikeDiagnosisText(fullInput || text);
    const placesFollowUp =
      looksLikePlacesFollowUp(history) && looksLikeLocationOnlyText(text);
    const placesRequested = looksLikePlacesRequest(fullInput || text);
    const placesIntent = Boolean(
      (placesRequested || placesFollowUp) && !diagnosisLikely
    );

    const placesQuery = buildPlacesQuerySmart({
      userText: fullInput || text,
      userLocation,
      placesFollowUp,
    });

    // INTERNAL INTEL
    const enginePack = buildEnginePack(fullInput || text);
    const internalIntelStrong = hasStrongInternalIntel(enginePack);

    // DATA-FIRST SEARCH
    // Always allow search.js to use internal KB/data first.
    // External places only when placesIntent=true.
    const searchPack = await searchSmart({
      query: placesIntent ? placesQuery : fullInput || text,
      userLocation,
      locale,
      allowPlaces: placesIntent,
      placesRadiusMeters,
    });

    const verifiedData = Array.isArray(searchPack?.verified_data)
      ? searchPack.verified_data
      : [];

    const verifiedWorkshops = Array.isArray(searchPack?.verified_workshops)
      ? searchPack.verified_workshops
      : [];

    // DIRECT PLACES MODE
    if (placesIntent && verifiedWorkshops.length > 0) {
      return {
        ok: true,
        reply: isArabic(locale)
          ? `تفضل هذه النتائج القريبة حسب طلبك:\n\n${formatWorkshopsForUser(
              verifiedWorkshops,
              locale
            )}`
          : `Here are nearby results based on your request:\n\n${formatWorkshopsForUser(
              verifiedWorkshops,
              locale
            )}`,
        locale,
        workshops_count: verifiedWorkshops.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places_direct_list",
                locale,
                placesIntent,
                placesRequested,
                placesFollowUp,
                placesQuery,
                userLocation,
              },
            }
          : {}),
      };
    }

    if (placesIntent && verifiedWorkshops.length === 0) {
      return {
        ok: true,
        reply: isArabic(locale)
          ? (placesFollowUp
              ? "ما ظهرت نتائج واضحة لهذا الموقع. جرّب تكتب المكان بشكل أدق أو فعّل GPS داخل التطبيق، وبعدها أعطيك النتائج مع الخرائط."
              : "أقدر أطلع لك ورش أو محلات أو أسعار قريبة، لكن أحتاج GPS أو اسم المنطقة أو الشارع بشكل أوضح. بعدها أعطيك النتائج مع الخرائط.")
          : (placesFollowUp
              ? "No clear results for that area. Send a more specific street or landmark, or enable GPS in the app, and I’ll return results with Maps links."
              : "I can show nearby shops, parts, or pricing results, but I need GPS or a clearer area or street. Then I’ll return results with Maps links."),
        locale,
        workshops_count: 0,
        ...(debugMode
          ? {
              debug: {
                stage: "places_zero_results",
                locale,
                placesIntent,
                placesRequested,
                placesFollowUp,
                placesQuery,
                userLocation,
              },
            }
          : {}),
      };
    }

    // DIAGNOSIS MODE
    const engineContextText = buildEngineContextText(enginePack);

    const strictContext = buildStrictContext({
      locale,
      userLocation,
      text: fullInput || text,
      voiceText,
      includeVoiceText,
      audioAttached,
      audioKindFinal,
      audioType,
      placesIntent,
      engineContextText,
      verifiedData,
      verifiedWorkshops,
      internalIntelStrong,
    });

    const stage1 = await createDoctorResponse({
      history,
      userTextBlock: strictContext,
      imageBase64,
      extraUserInstruction: buildStage1Instruction(locale),
      maxOutputTokens: Number(process.env.FIXLENS_MAX_TOKENS || 1100),
      temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.2),
    });

    const rawStage1 = String(stage1?.text || "").trim();

    if (looksLikeRefusal(rawStage1)) {
      return {
        ok: true,
        reply: safeFallbackReply(locale),
        locale,
        workshops_count: verifiedWorkshops.length,
        ...(debugMode
          ? {
              debug: {
                stage: "refusal_guard_stage1",
                locale,
                rawStage1,
                enginePack,
              },
            }
          : {}),
      };
    }

    const diag1 = extractFirstJsonObject(rawStage1);

    if (!diag1) {
      const fallback = rawStage1 || safeFallbackReply(locale);
      return {
        ok: true,
        reply: looksLikeRefusal(fallback)
          ? safeFallbackReply(locale)
          : fallback,
        locale,
        workshops_count: verifiedWorkshops.length,
        ...(debugMode
          ? {
              debug: {
                stage: "stage1_non_json_fallback",
                locale,
                rawStage1,
                enginePack,
              },
            }
          : {}),
      };
    }

    let answer = String(diag1?.final_answer || "").trim() || safeFallbackReply(locale);

    if (!placesIntent && violatesNoPlaces(answer)) {
      const rewrite = await createDoctorResponse({
        history: [],
        userTextBlock: strictContext,
        imageBase64,
        extraUserInstruction: buildRewriteInstruction(locale),
        maxOutputTokens: 700,
        temperature: 0.15,
      });

      const rewritten = String(rewrite?.text || "").trim();
      if (rewritten) answer = rewritten;
    }

    if (looksLikeRefusal(answer)) {
      answer = safeFallbackReply(locale);
    }

    // OPTIONAL REFINEMENT
    const needsSearch = Boolean(diag1?.needs_search);
    const searchQuery = String(diag1?.query || "").trim();
    const queryLooksPlacey = looksLikePlacesRequest(searchQuery);

    const allowExternalRefinement = shouldAllowExternalRefinement({
      diag1,
      enginePack,
      placesIntent,
    });

    if (
      allowExternalRefinement &&
      needsSearch &&
      searchQuery.length >= 3 &&
      !(!placesIntent && queryLooksPlacey)
    ) {
      const refineSearch = await searchSmart({
        query: searchQuery,
        userLocation,
        locale,
        allowPlaces: placesIntent,
        placesRadiusMeters,
      });

      const verifiedData2 = Array.isArray(refineSearch?.verified_data)
        ? refineSearch.verified_data
        : [];

      const verifiedWorkshops2 = Array.isArray(refineSearch?.verified_workshops)
        ? refineSearch.verified_workshops
        : [];

      const refineContext = `
STRICT_CONTEXT
LOCALE=${locale}
PLACES_INTENT=${placesIntent ? "true" : "false"}
LOCATION=${typeof userLocation === "string" ? userLocation : JSON.stringify(userLocation)}

ABSOLUTE_RULES:
- Reply in the locked user language only.
- Sound like a senior mechanic.
- No headings.
- No bullets.
- No numbering.
- If PLACES_INTENT=false, do not mention maps, shops, GPS, or location.
- Ask at most 2 questions only if essential.

${engineContextText}

DIAG_JSON_FROM_STAGE1=${JSON.stringify(diag1)}
VERIFIED_DATA_JSON=${JSON.stringify(verifiedData2)}
VERIFIED_WORKSHOPS_JSON=${JSON.stringify(verifiedWorkshops2)}
WORKSHOPS_CONTEXT_TEXT=
${formatWorkshopsForContext(verifiedWorkshops2)}

AUDIO_ATTACHED=${audioAttached ? "true" : "false"}
AUDIO_KIND=${audioKindFinal || ""}
AUDIO_TYPE=${audioType}
AUDIO_TRANSCRIPT=${includeVoiceText ? voiceText : ""}

USER_INPUT=${(fullInput || text).trim()}
`.trim();

      const stage2 = await createDoctorResponse({
        history: [],
        userTextBlock: refineContext,
        imageBase64,
        extraUserInstruction: buildRefineInstruction(locale),
        maxOutputTokens: Number(process.env.FIXLENS_MAX_TOKENS || 850),
        temperature: 0.2,
      });

      let reply2 =
        String(stage2?.text || "").trim() ||
        answer ||
        safeFallbackReply(locale);

      if (looksLikeRefusal(reply2)) reply2 = safeFallbackReply(locale);
      if (!placesIntent && violatesNoPlaces(reply2)) reply2 = answer;

      return {
        ok: true,
        reply: reply2,
        locale,
        workshops_count: verifiedWorkshops2.length,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_refined_external",
                locale,
                diag1,
                searchQuery,
                enginePack,
                allowExternalRefinement,
                internalIntelStrong,
              },
            }
          : {}),
      };
    }

    return {
      ok: true,
      reply: answer,
      locale,
      workshops_count: verifiedWorkshops.length,
      ...(debugMode
        ? {
            debug: {
              stage: "ok_stage1",
              locale,
              diagnosisLikely,
              placesIntent,
              placesQuery,
              enginePack,
              internalIntelStrong,
            },
          }
        : {}),
    };
  } catch (error) {
    console.error("FixLens Fatal:", error?.message || error);

    return {
      ok: false,
      reply: isArabic(locale)
        ? "حدث خطأ مؤقت، أعد المحاولة."
        : "Temporary error, please retry.",
      locale,
      workshops_count: 0,
    };
  }
}
