// service.js — FixLens "Doctor Brain" v3.2.0
// Clean version:
// - Responses API for diagnosis
// - Transcriptions API for speech-to-text
// - Global multilingual behavior
// - Data-first diagnosis before external refinement
// - Places / GPS / shops / parts search support
// - Hard gate: diagnosis vs places

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CHAT_MODEL = process.env.FIXLENS_MODEL || process.env.OPENAI_MODEL || "gpt-4.1";
const TRANSCRIBE_MODEL =
  process.env.FIXLENS_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

/* =========================================================
   LOAD DATA
========================================================= */
const DATA_DIR = path.join(process.cwd(), "data");
const VEHICLE_MAP_PATH = path.join(DATA_DIR, "vehicle_engine_map.json");
const ENGINE_PATTERNS_PATH = path.join(DATA_DIR, "engine_patterns.json");
const US_ENGINE_INTEL_PATH = path.join(DATA_DIR, "us_engine_intel_v1.json");

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
function normalizeToken(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, ms, label = "timeout") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function withRetry(fn, tries = 2, baseDelay = 250) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      await sleep(baseDelay * (i + 1));
    }
  }
  throw lastErr;
}

function normalizeUserLocation(raw) {
  if (!raw) return "";
  if (typeof raw === "string") {
    const v = raw.trim();
    if (!v) return "";
    if (v.toLowerCase() === "global") return "";
    return v;
  }
  if (typeof raw === "object") return raw;
  return "";
}

/* =========================================================
   LANGUAGE
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
  if (/[\u0100-\u017F]/.test(t)) return "de";
  return "en";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v || v.toLowerCase() === "auto") return "";
  return v;
}

function inferLocale({ locale, text, history = [] }) {
  const normalized = normalizeLocale(locale);
  const detected = detectTextLanguage(text || "");

  if (detected && detected !== "en") return detected;
  if (normalized) return normalized;

  for (let i = history.length - 1; i >= 0; i--) {
    const c = String(history[i]?.content || "");
    const h = detectTextLanguage(c);
    if (h && h !== "en") return h;
  }

  return detected || normalized || "en";
}

/* =========================================================
   VEHICLE + ENGINE INTEL
========================================================= */
function extractVehicleInfo(text = "") {
  const t = normalizeToken(text);

  const yearMatch = t.match(/\b(19|20)\d{2}\b/);
  const year = yearMatch ? Number(yearMatch[0]) : null;

  let make = null;
  let model = null;

  for (const row of VEHICLE_ENGINE_MAP) {
    const mk = normalizeToken(row?.make);
    const md = normalizeToken(row?.model);

    if (mk && t.includes(mk)) make = row.make;

    const mdLoose = md.replace(/-/g, "");
    const tLoose = t.replace(/-/g, "");
    if (md && (t.includes(md) || (mdLoose && tLoose.includes(mdLoose)))) {
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

  const found = VEHICLE_ENGINE_MAP.find((v) => {
    const vmk = normalizeToken(v?.make);
    const vmd = normalizeToken(v?.model);
    const range = Array.isArray(v?.year_range) ? v.year_range : [];
    const y0 = Number(range?.[0]);
    const y1 = Number(range?.[1]);

    if (!vmk || !vmd || !Number.isFinite(y0) || !Number.isFinite(y1)) return false;

    const sameMake = vmk === mk;
    const sameModel = vmd === md || vmd.replace(/-/g, "") === md.replace(/-/g, "");

    return sameMake && sameModel && year >= y0 && year <= y1;
  });

  if (!found || !Array.isArray(found.engines) || found.engines.length === 0) return null;
  return String(found.engines[0] || "").trim() || null;
}

function findSimpleEngineIssues(engineName = "") {
  const e = String(engineName || "").trim();
  if (!e) return [];

  const hit = ENGINE_PATTERNS.find(
    (x) => String(x?.engine || "").trim().toLowerCase() === e.toLowerCase()
  );

  const issues = Array.isArray(hit?.issues) ? hit.issues : [];
  return issues.slice(0, 6);
}

function matchSimpleEngineIssuesToText(issues = [], text = "") {
  const t = normalizeToken(text);
  const list = Array.isArray(issues) ? issues : [];

  return list
    .map((it) => {
      const kws = Array.isArray(it?.keywords) ? it.keywords : [];
      let score = 0;
      for (const k of kws) {
        const kk = normalizeToken(k);
        if (kk && t.includes(kk)) score += 1;
      }
      return { ...it, __score: score };
    })
    .filter((x) => Number(x.__score || 0) >= 1)
    .sort((a, b) => (b.__score || 0) - (a.__score || 0))
    .slice(0, 3);
}

function findIntelEnginesForVehicle(make, model, year) {
  const mk = normalizeToken(make);
  const md = normalizeToken(model);
  const y = Number(year);

  const engines = Array.isArray(US_ENGINE_INTEL?.engines) ? US_ENGINE_INTEL.engines : [];
  if (!mk || !md || !Number.isFinite(y)) return [];

  return engines
    .filter((e) => {
      const makes = Array.isArray(e?.makes) ? e.makes : [];
      const models = Array.isArray(e?.models) ? e.models : [];
      const years = Array.isArray(e?.years) ? e.years : [];

      const makeOk = makes.some((m) => normalizeToken(m) === mk);
      const modelOk = models.some((m) => normalizeToken(m) === md);
      const yearOk = years.some((yy) => Number(yy) === y);

      return makeOk && modelOk && yearOk;
    })
    .slice(0, 3);
}

function getIntelPatternByKey(pattern_key = "") {
  const key = String(pattern_key || "").trim();
  if (!key) return null;

  const patterns = Array.isArray(US_ENGINE_INTEL?.patterns) ? US_ENGINE_INTEL.patterns : [];
  return patterns.find((p) => String(p?.pattern_key || "").trim() === key) || null;
}

function scoreIntelPattern(pattern, text = "") {
  if (!pattern) return 0;
  const t = normalizeToken(text);

  const when = pattern?.when || {};
  const sym = Array.isArray(when?.symptom_keywords_any) ? when.symptom_keywords_any : [];
  const extra = Array.isArray(when?.extra_clues_any) ? when.extra_clues_any : [];

  let score = 0;
  for (const k of sym) {
    const kk = normalizeToken(k);
    if (kk && t.includes(kk)) score += 2;
  }
  for (const k of extra) {
    const kk = normalizeToken(k);
    if (kk && t.includes(kk)) score += 1;
  }
  return score;
}

function matchBestIntelPatternForEngine(engineObj, text = "") {
  if (!engineObj) return { pattern: null, score: 0 };

  const common = Array.isArray(engineObj?.common_patterns) ? engineObj.common_patterns : [];
  if (common.length === 0) return { pattern: null, score: 0 };

  let best = { pattern: null, score: 0 };

  for (const key of common) {
    const p = getIntelPatternByKey(key);
    const s = scoreIntelPattern(p, text);
    if (s > best.score) best = { pattern: p, score: s };
  }

  if (best.score < 2) return { pattern: null, score: best.score };
  return best;
}

function buildEnginePack(userText = "") {
  const vehicle = extractVehicleInfo(userText);
  const detectedEngineName = detectEngineFromVehicle(vehicle.make, vehicle.model, vehicle.year);

  const simpleIssues = detectedEngineName ? findSimpleEngineIssues(detectedEngineName) : [];
  const simpleMatched = matchSimpleEngineIssuesToText(simpleIssues, userText);

  const intelEngines = findIntelEnginesForVehicle(vehicle.make, vehicle.model, vehicle.year);

  let bestIntel = { engine: null, pattern: null, score: 0 };
  for (const eng of intelEngines) {
    const m = matchBestIntelPatternForEngine(eng, userText);
    if (m.score > bestIntel.score && m.pattern) {
      bestIntel = { engine: eng, pattern: m.pattern, score: m.score };
    }
  }

  return {
    vehicle,
    detected_engine_name: detectedEngineName || null,
    simple_engine_issue_matches: simpleMatched,
    intel_engine_candidate_count: intelEngines.length,
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

function buildEngineContextText(enginePack) {
  const vehicle = enginePack?.vehicle || {};
  const detectedEngineName = enginePack?.detected_engine_name || null;
  const simpleMatches = Array.isArray(enginePack?.simple_engine_issue_matches)
    ? enginePack.simple_engine_issue_matches
    : [];
  const intelEngine = enginePack?.intel_best_engine || null;
  const intelPattern = enginePack?.intel_best_pattern || null;

  return `
ENGINE_CONTEXT (FixLens Engine Intelligence):
- VEHICLE_MENTION: ${JSON.stringify(vehicle)}
- DETECTED_ENGINE_NAME_FROM_MAP: ${detectedEngineName ? detectedEngineName : "null"}
- SIMPLE_ENGINE_ISSUES_MATCHED: ${JSON.stringify(simpleMatches)}
- BEST_ENGINE_OBJECT: ${JSON.stringify(intelEngine)}
- BEST_PATTERN_OBJECT: ${JSON.stringify(intelPattern)}

RULES:
- Use engine context only to sharpen diagnosis and next tests.
- If BEST_PATTERN_OBJECT exists, choose only the most useful questions.
- If internal engine/data evidence is already strong, prefer that before external search.
- Never invent details not present here.
`.trim();
}

/* =========================================================
   INTENT
========================================================= */
function looksLikeDiagnosisText(input = "") {
  const t = String(input || "").toLowerCase();
  const words = [
    "noise","sound","rattle","knock","ticking","click","clunk","grind","squeal",
    "vibration","shake","misfire","stall","idle","engine","brake","steering",
    "overheat","smoke","leak","check engine","p0","code","codes",
    "صوت","طقطقة","طرطقة","تك تك","نق","خبط","خشخشة","صرير","زقزقة",
    "رجفة","اهتزاز","هزة","تقطيع","تنتيع","تفتفة",
    "محرك","مكينة","فرامل","دركسون","ستيرنغ",
    "حرارة","سخونة","دخان","تهريب","تسريب","لمبة","تشيك","عطل","كود","اكواد"
  ];
  return words.some((w) => t.includes(w));
}

function looksLikeNearbyRequest(input = "") {
  const t = String(input || "").toLowerCase();
  const nearby = [
    "near me","nearby","closest","around me","near",
    "اقرب","أقرب","بالقرب","قريب","قريبة","حولّي","حولي","يمّي","جنبي"
  ];
  return nearby.some((w) => t.includes(w));
}

function looksLikeShopOrPartsWords(input = "") {
  const t = String(input || "").toLowerCase();
  const strong = [
    "mechanic","garage","auto repair","repair shop","car repair",
    "auto parts","car parts","parts store","tool store","hardware store",
    "autozone","o'reilly","oreilly","advance auto","napa","price","prices","cost",
    "ورشة","ورش","ورشة سيارات","تصليح سيارات","ميكانيكي","ميكانيك","مكانيكي","مكانيك",
    "كراج","كراج سيارات","قطع غيار","محل قطع","محل قطع غيار","محل ادوات","محل أدوات",
    "بنشر","بنچر","إطارات","اطارات","كهربائي سيارات","ورشة كهرباء","سمكري","حدادة سيارات",
    "سعر","اسعار","تكلفة","قطعة","رقم القطعة"
  ];
  return strong.some((w) => t.includes(w));
}

function looksLikeMapAddressWords(input = "") {
  const t = String(input || "").toLowerCase();
  const weak = [
    "address","location","map","google maps","directions","where","gps",
    "عنوان","موقع","خرائط","خريطة","لوكيشن","دلني","وين","وينه","اشرلي","رمز بريدي"
  ];
  return weak.some((w) => t.includes(w));
}

function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();
  if (looksLikeNearbyRequest(t)) return true;
  if (looksLikeShopOrPartsWords(t)) return true;
  if (looksLikeMapAddressWords(t) && looksLikeShopOrPartsWords(t)) return true;
  return false;
}

function getLastAssistantText(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant") {
      return String(history[i]?.content || "");
    }
  }
  return "";
}

function looksLikePlacesFollowUp(history = []) {
  const a = getLastAssistantText(history).toLowerCase();
  if (!a) return false;

  const askSignals = [
    "gps", "enable location", "allow location",
    "zip", "zipcode", "postal",
    "area", "neighborhood", "district", "where are you",
    "فعّل gps", "فعل gps", "اسم المنطقة", "اسم الحي", "اسم الشارع",
    "حدد المنطقة", "حدد الحي", "حدد موقعك", "موقعك", "وين انت", "وين", "بالقرب"
  ];

  return askSignals.some((w) => a.includes(w));
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
function hasLatLng(loc) {
  if (!loc || typeof loc !== "object") return false;
  const lat = Number(loc.lat ?? loc.latitude);
  const lng = Number(loc.lng ?? loc.longitude ?? loc.lon);
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function inferPlacesCategory(text = "") {
  const t = String(text || "").toLowerCase();

  if (
    ["parts", "auto parts", "car parts", "parts store", "autozone", "o'reilly", "oreilly",
      "advance auto", "napa", "قطع", "قطع غيار", "محل قطع", "محل قطع غيار", "price", "prices"
    ].some((w) => t.includes(w))
  ) {
    return "auto parts store";
  }

  if (
    ["tire", "tyre", "tires", "tyres", "tire shop", "wheel", "alignment",
      "إطارات", "اطارات", "بنشر", "بنچر", "ميزان", "ترصيص"
    ].some((w) => t.includes(w))
  ) {
    return "tire shop";
  }

  if (
    ["brake", "brakes", "brake shop", "فرامل", "بريك", "هوبات", "سفايف"].some((w) =>
      t.includes(w)
    )
  ) {
    return "brake shop";
  }

  if (
    ["auto electrician", "car electrician", "electrical", "starter", "alternator", "battery",
      "كهربائي سيارات", "كهرباء سيارات", "دينمو", "سلف", "بطارية"
    ].some((w) => t.includes(w))
  ) {
    return "auto electrical repair";
  }

  if (
    ["body shop", "collision", "paint", "dent", "panel", "سمكري", "صبغ", "دهان"].some((w) =>
      t.includes(w)
    )
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

function buildPlacesQuerySmart({ userText = "", user_location = "", placesFollowUp = false }) {
  const raw = String(userText || "").trim();
  const category = inferPlacesCategory(raw);

  if (hasLatLng(user_location)) return category;

  const locStr =
    typeof user_location === "string" && user_location.trim() ? user_location.trim() : "";

  if (placesFollowUp) {
    const followLoc = raw.length <= 80 ? raw : extractLocationHint(raw);
    const finalLoc = (followLoc || locStr || raw).trim();
    return finalLoc ? `${category} near ${finalLoc}` : category;
  }

  const hint = extractLocationHint(raw);
  const bestLoc = (hint || locStr || "").trim();
  if (bestLoc) return `${category} near ${bestLoc}`;

  return category;
}

/* =========================================================
   AUDIO
========================================================= */
function containsSmellWords(s = "") {
  const t = String(s || "").toLowerCase();
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

function estimateSpeechFromVerboseOrText(res) {
  const segments = Array.isArray(res?.segments) ? res.segments : [];
  if (segments.length > 0) {
    let speechVotes = 0;
    let total = 0;
    for (const s of segments) {
      const p = Number(s?.no_speech_prob);
      if (!Number.isFinite(p)) continue;
      total += 1;
      if (p < 0.6) speechVotes += 1;
    }
    if (total > 0) {
      const ratio = speechVotes / total;
      if (ratio >= 0.5) return { hasSpeech: true, score: ratio };
      if (ratio <= 0.25) return { hasSpeech: false, score: ratio };
      return { hasSpeech: null, score: ratio };
    }
  }

  const rawText = String(res?.text || "").trim();
  if (!rawText) return { hasSpeech: false, score: 0 };
  const looksWordy = /[a-zA-Z\u0600-\u06FF]{3,}/.test(rawText);
  if (!looksWordy) return { hasSpeech: null, score: 0.3 };
  return { hasSpeech: true, score: 0.8 };
}

async function transcribeAudioSmart(audioBase64, locale, audioKind = "car_sound") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

  const kind = String(audioKind || "car_sound").toLowerCase().trim();
  const isVoice = kind === "voice";
  const tempPath = path.join("/tmp", `fixlens_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const res = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: TRANSCRIBE_MODEL,
          response_format: "verbose_json",
          prompt:
            "Audio may be speech or non-speech automotive sounds such as engine, brakes, ticking, squeal, idle, steering, or exhaust. If no spoken words, keep text very short or empty.",
          language: String(locale || "").split("-")[0] || undefined,
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const rawText = String(res?.text || "").trim();
    const speechEst = estimateSpeechFromVerboseOrText(res);

    if (!isVoice) {
      const looksWordy = /[a-zA-Z\u0600-\u06FF]{3,}/.test(rawText);
      if (rawText && looksWordy && rawText.length <= 240) {
        return {
          ok: true,
          text: rawText,
          audio_type: "speech_detected_in_car_sound",
          speech_score: speechEst.score,
        };
      }
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    if (rawText.length > 320) {
      return { ok: true, text: "", audio_type: "speech_garbage", speech_score: speechEst.score };
    }

    if (speechEst.hasSpeech === false) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    const looksWordy = /[a-zA-Z\u0600-\u06FF]{3,}/.test(rawText);
    if (rawText && looksWordy) {
      return { ok: true, text: rawText, audio_type: "speech", speech_score: speechEst.score };
    }

    return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { ok: false, text: "", audio_type: "error", speech_score: 0 };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

/* =========================================================
   RESPONSES API HELPERS
========================================================= */
function tryJsonParse(s = "") {
  try {
    return JSON.parse(String(s || "").trim());
  } catch {
    return null;
  }
}

function extractFirstJsonObject(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const direct = tryJsonParse(raw);
  if (direct) return direct;

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
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

function getResponseText(res) {
  if (!res) return "";
  if (typeof res.output_text === "string" && res.output_text.trim()) return res.output_text.trim();

  const output = Array.isArray(res.output) ? res.output : [];
  const texts = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const c of content) {
      if (c?.type === "output_text" && c?.text) texts.push(String(c.text));
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
  return history.slice(-6).map(historyItemToResponsesMessage).filter(Boolean);
}

async function createDoctorResponse({
  history = [],
  userTextBlock = "",
  imageBase64 = "",
  extraUserInstruction = "",
  maxOutputTokens = 900,
  temperature = 0.3,
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

  const response = await withRetry(
    () =>
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
      ),
    2
  );

  return {
    raw: response,
    text: getResponseText(response),
  };
}

/* =========================================================
   OUTPUT GUARDS
========================================================= */
function violatesNoPlaces(reply = "") {
  const t = String(reply || "").toLowerCase();
  const bad = [
    "zip","zipcode","postal","postcode","gps","near me","nearby","closest","google maps","maps","address","location",
    "area","neighborhood","district","city","town","where are you",
    "ورشة","ورش","ميكانيك","ميكانيكي","كراج","خرائط","خريطة","لوكيشن","عنوان","موقعك","حدد موقعك",
    "رمز بريدي","قريب","اقرب","أقرب","منطقة","حي","مدينة","وين انت","دلني","اشرلي"
  ];
  return bad.some((w) => t.includes(w));
}

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
    "policy",
    "cannot comply",
    "i can't provide",
  ].some((p) => t.includes(p));
}

function safeFallbackReply(locale = "en") {
  const isAr = String(locale || "").toLowerCase().startsWith("ar");
  return isAr
    ? "وصلتني الأعراض أو المرفقات. أقوى الاحتمالات الآن: misfire من بواجي أو كويلات، خلل هواء أو وقود مثل MAF أو بخاخ، أو دق حقيقي بسبب توقيت أو وقود. حتى أحددها بدقة: هل لمبة Check Engine شغالة، وهل الصوت أقرب إلى تك تك سريع أم دق ثقيل؟"
    : "I got your symptoms or attachments. The strongest possibilities right now are misfire from plugs or coils, an air-fuel issue like MAF or injectors, or true knock from timing or fuel. To narrow it down properly: is the Check Engine light on, and is the sound more like a fast tick or a deeper knock?";
}

/* =========================================================
   WORKSHOP FORMATTING
========================================================= */
function formatWorkshopsForContext(workshops = []) {
  const list = Array.isArray(workshops) ? workshops : [];
  return list
    .slice(0, 6)
    .map((w, idx) => {
      const name = w?.name || w?.title || "Workshop";
      const addr = w?.address || w?.formatted_address || w?.vicinity || "";
      const phone = w?.phone || w?.formatted_phone_number || "";
      const rating = w?.rating ? `rating:${w.rating}` : "";
      const url = w?.maps_url || w?.google_maps_url || w?.googleMapsUri || w?.url || "";
      const website = w?.website || w?.websiteUri || "";
      const price = w?.price_hint || "";
      return `${idx + 1}) ${[name, addr, phone, rating, price, url, website]
        .filter(Boolean)
        .join(" | ")}`;
    })
    .join("\n");
}

function formatWorkshopsForUser(workshops = [], locale = "en") {
  const isAr = String(locale || "").toLowerCase().startsWith("ar");
  const list = Array.isArray(workshops) ? workshops : [];

  return list
    .slice(0, 5)
    .map((w, i) => {
      const name = w?.name || w?.title || (isAr ? "ورشة" : "Shop");
      const addr = w?.address || w?.formatted_address || w?.vicinity || "";
      const phone = w?.phone || w?.formatted_phone_number || "";
      const url = w?.maps_url || w?.google_maps_url || w?.googleMapsUri || w?.url || "";
      const price = w?.price_hint || "";

      return [
        `${i + 1}) ${name}`,
        addr ? (isAr ? `العنوان: ${addr}` : `Address: ${addr}`) : "",
        phone ? (isAr ? `هاتف: ${phone}` : `Phone: ${phone}`) : "",
        price || "",
        url ? (isAr ? `خرائط: ${url}` : `Maps: ${url}`) : "",
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
  user_location,
  placesIntent,
  engineContextText,
  verifiedData,
  verifiedWorkshops,
  audioAttached,
  audioKindFinal,
  audioType,
  includeVoiceText,
  voiceText,
  text,
  dataFirstStrong,
}) {
  const audioNote = audioAttached
    ? `AUDIO_NOTE: AUDIO_ATTACHED=true. AUDIO_KIND=${audioKindFinal || "car_sound"}. If AUDIO_KIND is non-speech car sound, do not pretend you analyzed the waveform.`
    : "";

  return `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}
DATA_FIRST_INTERNAL_INTEL_STRONG: ${dataFirstStrong ? "true" : "false"}

ABSOLUTE_RULES:
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city and NEVER mention nearby shops/maps.
- Reply in the user's language.
- Sound like a senior diagnostic mechanic, not a generic assistant.
- Lead with the strongest likely cause first.
- Use internal data first before asking for external refinement when evidence is already strong.
- No headings. No bullets. No numbering.
- Ask max 2 questions only if they materially improve the next step.
- If the issue is safety-critical, say so briefly and clearly.

${engineContextText}

VERIFIED_DATA_JSON: ${JSON.stringify(verifiedData)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(verifiedWorkshops)}
WORKSHOPS_CONTEXT_TEXT:
${formatWorkshopsForContext(verifiedWorkshops)}

AUDIO_ATTACHED: ${audioAttached ? "true" : "false"}
AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${includeVoiceText ? voiceText : ""}

${audioNote}

USER_INPUT: ${text.trim()}
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
- needs_search=true only if external verified search materially improves the answer beyond current context and internal data
- query="" unless needs_search=true
- final_answer must be in locale "${locale}"
- final_answer must sound like a trusted master mechanic
- final_answer must be practical, causal, and natural
- final_answer must not contain headings, bullets, or numbering
- final_answer asks max 2 questions only if necessary
`.trim();
}

function buildRewriteInstruction(locale = "en") {
  return `
Rewrite the answer in locale "${locale}" as a real diagnostic mechanic.

Rules:
- No headings
- No bullets
- No numbering
- No ZIP/GPS/city/maps/shops unless PLACES_INTENT is true
- Max 2 questions only if essential
- Sound calm, confident, and practical
- Lead with the strongest likely cause

Return only the final answer text.
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
- No map/shop/location talk unless PLACES_INTENT is true
- Max 2 questions only if essential
- Use verified data only to sharpen diagnosis and next step
- Clear, confident, natural

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
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "");
  const history = Array.isArray(body.history) ? body.history : [];

  let locale = inferLocale({ locale: body.locale, text, history });

  const user_location = normalizeUserLocation(body.user_location) || "";
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  const audio_kind = String(body.audio_kind || "").trim();
  const audioKindFinal = audio_base_64 ? (audio_kind || "car_sound") : "";
  const placesRadiusMeters = Number(
    body.places_radius_meters || process.env.PLACES_RADIUS_METERS || 25000
  );

  try {
    if (!text.trim() && !audio_base_64 && !image_base_64) {
      return {
        ok: false,
        reply: String(locale || "").toLowerCase().startsWith("ar")
          ? "اكتب الأعراض أو أرسل صورة أو صوت، وأنا أبدأ معك."
          : "Send symptoms or attach a photo or audio and I’ll start.",
        locale,
        workshops_count: 0,
        ...(debugMode ? { debug: { stage: "empty_input" } } : {}),
      };
    }

    // AUDIO
    const audioAttached = Boolean(audio_base_64);
    const audioSmart = await transcribeAudioSmart(audio_base_64, locale, audioKindFinal);
    let voiceText = audioSmart.ok ? String(audioSmart.text || "").trim() : "";
    const audioType = audioSmart.audio_type || "none";

    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    const includeVoiceText =
      audioType === "speech" || audioType === "speech_detected_in_car_sound";

    const fullInput = `${text} ${includeVoiceText ? voiceText : ""}`.trim();
    locale = inferLocale({ locale: body.locale || locale, text: fullInput || text, history });

    // INTENT
    const diagnosisLikely = looksLikeDiagnosisText(fullInput || text);
    const placesFollowUp = looksLikePlacesFollowUp(history) && looksLikeLocationOnlyText(text);
    const placesRequested = looksLikePlacesRequest(text);
    const placesIntent = Boolean((placesRequested || placesFollowUp) && !diagnosisLikely);

    const placesQuery = buildPlacesQuerySmart({
      userText: fullInput || text,
      user_location,
      placesFollowUp,
    });

    // INTERNAL DATA
    const enginePack = buildEnginePack(fullInput || text);
    const internalIntelStrong = hasStrongInternalIntel(enginePack);

    // SEARCH (keep active for places / verified KB)
    const searchPack = await withRetry(
      () =>
        withTimeout(
          performSearch(placesQuery, user_location, {
            locale,
            allowPlaces: placesIntent,
            placesRadiusMeters,
          }),
          Number(process.env.SEARCH_TIMEOUT_MS || 15000),
          "search_timeout"
        ),
      2
    );

    const VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
    const VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops)
      ? searchPack.verified_workshops
      : [];

    // DIRECT PLACES RESPONSE
    if (placesIntent && VERIFIED_WORKSHOPS.length > 0) {
      const isAr = String(locale || "").toLowerCase().startsWith("ar");
      return {
        ok: true,
        reply: isAr
          ? `تفضل هذه النتائج القريبة حسب طلبك:\n\n${formatWorkshopsForUser(VERIFIED_WORKSHOPS, locale)}`
          : `Here are nearby results based on your request:\n\n${formatWorkshopsForUser(VERIFIED_WORKSHOPS, locale)}`,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places_direct_list",
                placesIntent,
                placesRequested,
                placesFollowUp,
                placesQuery,
                user_location,
              },
            }
          : {}),
      };
    }

    // NO PLACES RESULTS
    if (placesIntent && VERIFIED_WORKSHOPS.length === 0) {
      const isAr = String(locale || "").toLowerCase().startsWith("ar");
      return {
        ok: true,
        reply: isAr
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
                stage: "places_intent_but_zero_results",
                diagnosisLikely,
                placesIntent,
                placesRequested,
                placesFollowUp,
                placesQuery,
                user_location,
              },
            }
          : {}),
      };
    }

    // MAIN CONTEXT
    const engineContextText = buildEngineContextText(enginePack);

    const strictText = buildStrictContext({
      locale,
      user_location,
      placesIntent,
      engineContextText,
      verifiedData: VERIFIED_DATA,
      verifiedWorkshops: VERIFIED_WORKSHOPS,
      audioAttached,
      audioKindFinal,
      audioType,
      includeVoiceText,
      voiceText,
      text,
      dataFirstStrong: internalIntelStrong,
    });

    // STAGE 1
    const stage1 = await createDoctorResponse({
      history,
      userTextBlock: strictText,
      imageBase64: image_base_64,
      extraUserInstruction: buildStage1Instruction(locale),
      maxOutputTokens: Number(process.env.FIXLENS_MAX_TOKENS || 1100),
      temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.3),
    });

    const raw1 = String(stage1?.text || "").trim();

    if (looksLikeRefusal(raw1)) {
      return {
        ok: true,
        reply: safeFallbackReply(locale),
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "refusal_guard_stage1",
                raw1,
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
                enginePack,
              },
            }
          : {}),
      };
    }

    const diag1 = extractFirstJsonObject(raw1);
    let answer1 = String(diag1?.final_answer || "").trim();

    if (!diag1) {
      const fallback = raw1 || safeFallbackReply(locale);
      return {
        ok: true,
        reply: looksLikeRefusal(fallback) ? safeFallbackReply(locale) : fallback,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_no_json_stage1",
                raw1,
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
                enginePack,
              },
            }
          : {}),
      };
    }

    if (!answer1) answer1 = safeFallbackReply(locale);

    if (!placesIntent && violatesNoPlaces(answer1)) {
      const rewrite = await createDoctorResponse({
        history: [],
        userTextBlock: strictText,
        imageBase64: image_base_64,
        extraUserInstruction: buildRewriteInstruction(locale),
        maxOutputTokens: 750,
        temperature: 0.2,
      });

      const forced = String(rewrite?.text || "").trim();
      if (forced) answer1 = forced;
    }

    if (looksLikeRefusal(answer1)) {
      answer1 = safeFallbackReply(locale);
    }

    // STAGE 2 (optional, data-first)
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
      const searchPack2 = await withRetry(
        () =>
          withTimeout(
            performSearch(searchQuery, user_location, {
              locale,
              allowPlaces: placesIntent,
              placesRadiusMeters,
            }),
            Number(process.env.SEARCH_TIMEOUT_MS || 15000),
            "search_timeout"
          ),
        2
      );

      const VERIFIED_DATA_2 = Array.isArray(searchPack2?.verified_data)
        ? searchPack2.verified_data
        : [];
      const VERIFIED_WORKSHOPS_2 = Array.isArray(searchPack2?.verified_workshops)
        ? searchPack2.verified_workshops
        : [];

      const refineStrict = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ABSOLUTE_RULES:
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city and NEVER mention shops/maps.
- Reply in the user's language only.
- Sound like a senior mechanic.
- No headings. No bullets. No numbering.
- Ask max 2 questions only if essential.

${engineContextText}

DIAG_JSON_FROM_STAGE1: ${JSON.stringify(diag1)}
VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA_2)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS_2)}
WORKSHOPS_CONTEXT_TEXT:
${formatWorkshopsForContext(VERIFIED_WORKSHOPS_2)}

AUDIO_ATTACHED: ${audioAttached ? "true" : "false"}
AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${includeVoiceText ? voiceText : ""}

USER_INPUT: ${text.trim()}
`.trim();

      const stage2 = await createDoctorResponse({
        history: [],
        userTextBlock: refineStrict,
        imageBase64: image_base_64,
        extraUserInstruction: buildRefineInstruction(locale),
        maxOutputTokens: Number(process.env.FIXLENS_MAX_TOKENS || 850),
        temperature: 0.28,
      });

      let reply2 =
        String(stage2?.text || "").trim() || answer1 || safeFallbackReply(locale);

      if (looksLikeRefusal(reply2)) reply2 = safeFallbackReply(locale);
      if (!placesIntent && violatesNoPlaces(reply2)) reply2 = answer1;

      return {
        ok: true,
        reply: reply2,
        locale,
        workshops_count: VERIFIED_WORKSHOPS_2.length,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_refined_external",
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
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
      reply: answer1 || safeFallbackReply(locale),
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      ...(debugMode
        ? {
            debug: {
              stage: "ok_stage1",
              audioType,
              speech_score: audioSmart.speech_score,
              diagnosisLikely,
              placesIntent,
              diag1,
              enginePack,
              placesQuery,
              allowExternalRefinement,
              internalIntelStrong,
            },
          }
        : {}),
    };
  } catch (error) {
    console.error("FixLens Fatal:", error?.message || error);
    return {
      ok: false,
      reply: String(locale || "").toLowerCase().startsWith("ar")
        ? "حدث خطأ مؤقت، أعد المحاولة."
        : "Temporary error, please retry.",
      locale,
      workshops_count: 0,
    };
  }
}
