// service.js — FixLens "Doctor Brain" v2.4 (Engine Intelligence Layer Enabled + Smarter Pattern Matching + Better Doctor Output)
// Fixes:
// 1) Engine Intelligence is now actively used (rank + match patterns against user symptoms).
// 2) Removed "max 2 questions" forced constraint. DoctorPrompt controls question policy.
// 3) Engine context is summarized + matched issues are provided to the model (not raw dump only).

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LOAD ENGINE INTELLIGENCE (US market) — from /data
========================================================= */
const DATA_DIR = path.join(process.cwd(), "data");
const VEHICLE_MAP_PATH = path.join(DATA_DIR, "vehicle_engine_map.json");
const ENGINE_PATTERNS_PATH = path.join(DATA_DIR, "engine_patterns.json");

let VEHICLE_ENGINE_MAP = [];
let ENGINE_PATTERNS = [];

function safeLoadJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch {
    return fallback;
  }
}

// Load once on boot
VEHICLE_ENGINE_MAP = safeLoadJson(VEHICLE_MAP_PATH, []);
ENGINE_PATTERNS = safeLoadJson(ENGINE_PATTERNS_PATH, []);

/* =========================================================
   ENGINE LAYER (Option B): Vehicle -> Engine inference
========================================================= */
function normalizeToken(s = "") {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
    if (md && (t.includes(md) || (mdLoose && tLoose.includes(mdLoose)))) model = row.model;

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

function findEnginePatterns(engineName = "") {
  const e = String(engineName || "").trim();
  if (!e) return [];

  const hit = ENGINE_PATTERNS.find(
    (x) => String(x?.engine || "").trim().toLowerCase() === e.toLowerCase()
  );
  const issues = Array.isArray(hit?.issues) ? hit.issues : [];
  return issues.slice(0, 12);
}

function buildEngineContext(text = "") {
  const info = extractVehicleInfo(text);
  const detectedEngine = detectEngineFromVehicle(info.make, info.model, info.year);

  if (!detectedEngine) {
    return { vehicle: info, engine: null, patterns: [], confidence: "low" };
  }

  const patterns = findEnginePatterns(detectedEngine);

  // If we got year+make+model and matched a range -> confidence high; else medium.
  const hasAll = Boolean(info.make && info.model && Number.isFinite(info.year));
  const confidence = hasAll ? "high" : "medium";

  return { vehicle: info, engine: detectedEngine, patterns, confidence };
}

/* =========================================================
   ENGINE PATTERN MATCHING (rank issues against user symptoms)
========================================================= */
function toKeywords(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((x) => toKeywords(x));
  }
  if (typeof value === "string") {
    return value
      .split(/[,/|;]/g)
      .map((s) => normalizeToken(s))
      .filter(Boolean);
  }
  return [];
}

function collectIssueKeywords(issue = {}) {
  // We try multiple possible keys to support different JSON formats:
  // symptoms, triggers, keywords, tags, cues, when, notes
  const keys = [
    issue?.symptoms,
    issue?.triggers,
    issue?.keywords,
    issue?.tags,
    issue?.cues,
    issue?.when,
    issue?.notes,
    issue?.description,
    issue?.name,
    issue?.title,
  ];

  const out = [];
  for (const k of keys) out.push(...toKeywords(k));
  // Remove duplicates
  return Array.from(new Set(out)).filter((s) => s.length >= 3).slice(0, 50);
}

function scoreIssueMatch(userText = "", issue = {}) {
  const t = normalizeToken(userText);
  if (!t) return 0;

  const kws = collectIssueKeywords(issue);
  if (kws.length === 0) return 0;

  let score = 0;

  for (const kw of kws) {
    // Lightweight matching
    if (t.includes(kw)) score += 2;
    else {
      // token overlap (partial)
      const parts = kw.split(" ").filter(Boolean);
      if (parts.length >= 2) {
        const hits = parts.filter((p) => p.length >= 3 && t.includes(p)).length;
        if (hits >= 2) score += 1;
      }
    }
  }

  // small bonus if user mentions codes and issue seems code related
  const hasCode = /\bp0\d{3}\b/i.test(userText);
  if (hasCode) {
    const issueText = JSON.stringify(issue).toLowerCase();
    if (issueText.includes("p0") || issueText.includes("dtc") || issueText.includes("code")) score += 1;
  }

  return score;
}

function rankEngineIssues(userText = "", issues = []) {
  const list = Array.isArray(issues) ? issues : [];
  const scored = list
    .map((it) => ({ issue: it, score: scoreIssueMatch(userText, it) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Return top 6 matched issues
  return scored.slice(0, 6).map((x) => x.issue);
}

/* =========================================================
   LOCATION NORMALIZER
========================================================= */
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
  return "en";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v || v.toLowerCase() === "auto") return "";
  return v;
}

function inferLocale({ locale, text }) {
  const normalized = normalizeLocale(locale);
  const detected = detectTextLanguage(text || "");
  if (detected && detected !== "en") return detected;
  if (normalized) return normalized;
  return detected || "en";
}

/* =========================================================
   TIMEOUT + RETRY
========================================================= */
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

/* =========================================================
   INTENT: DIAGNOSIS vs PLACES
========================================================= */
function looksLikeDiagnosisText(input = "") {
  const t = String(input || "").toLowerCase();
  const words = [
    // English
    "noise","sound","rattle","knock","ticking","click","clunk","grind","squeal",
    "vibration","shake","misfire","stall","idle","engine","brake","steering",
    "overheat","smoke","leak","check engine","p0",
    // Arabic
    "صوت","طقطقة","طرطقة","تك تك","نق","خبط","خشخشة","صرير","زقزقة",
    "رجفة","اهتزاز","هزة","تقطيع","تنتيع","تفتفة",
    "محرك","مكينة","فرامل","دركسون","ستيرنغ",
    "حرارة","سخونة","دخان","تهريب","تسريب","لمبة","تشيك"
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
    // English
    "mechanic","garage","auto repair","repair shop","car repair",
    "auto parts","car parts","parts store","tool store","hardware store",
    "autozone","o'reilly","oreilly","advance auto","napa",

    // Arabic
    "ورشة","ورش","ورشة سيارات","تصليح سيارات","ميكانيكي","ميكانيك","مكانيكي","مكانيك",
    "ميكانكي","ميكانك","كراج","كراج سيارات",
    "قطع غيار","محل قطع","محل قطع غيار","محل ادوات","محل أدوات","ادوات","أدوات"
  ];

  return strong.some((w) => t.includes(w));
}

function looksLikeMapAddressWords(input = "") {
  const t = String(input || "").toLowerCase();
  const weak = [
    "address","location","map","google maps","directions","where",
    "عنوان","موقع","خرائط","خريطة","لوكيشن","دلّني","دلني","وين","وينه","اشرلي",
    "zip","zipcode","postal","postcode","رمز بريدي"
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

/* =========================================================
   PLACES FOLLOW-UP (STATELESS MEMORY FROM HISTORY)
========================================================= */
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
    // Arabic
    "فعّل gps", "فعل gps", "اسم المنطقة", "اسم الحي", "اسم الشارع",
    "حدد المنطقة", "حدد الحي", "حدد موقعك", "موقعك", "وين انت", "وين", "بالقرب"
  ];

  return askSignals.some((w) => a.includes(w));
}

function looksLikeLocationOnlyText(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 60) return false;
  if (looksLikeDiagnosisText(t)) return false;
  if (looksLikePlacesRequest(t)) return false;

  return /^[\u0600-\u06FFa-zA-Z0-9\s\-\.,]+$/.test(t);
}

/* =========================================================
   AUDIO HELPERS
========================================================= */
function containsSmellWords(s = "") {
  const t = String(s || "").toLowerCase();
  return (
    t.includes("smell") || t.includes("burning") || t.includes("plastic") || t.includes("odor") ||
    t.includes("رائحة") || t.includes("حرق") || t.includes("بلاستيك")
  );
}

function estimateSpeechFromWhisperVerbose(verbose) {
  const segments = Array.isArray(verbose?.segments) ? verbose.segments : [];
  if (segments.length === 0) return { hasSpeech: null, score: 0 };

  let speechVotes = 0;
  let total = 0;

  for (const s of segments) {
    const p = Number(s?.no_speech_prob);
    if (!Number.isFinite(p)) continue;
    total += 1;
    if (p < 0.6) speechVotes += 1;
  }

  if (total === 0) return { hasSpeech: null, score: 0 };
  const ratio = speechVotes / total;

  if (ratio >= 0.5) return { hasSpeech: true, score: ratio };
  if (ratio <= 0.25) return { hasSpeech: false, score: ratio };
  return { hasSpeech: null, score: ratio };
}

/**
 * IMPORTANT NOTE:
 * Whisper is not great for non-speech mechanical audio.
 * We still run it to detect accidental speech, but we DO NOT pretend
 * we "analyzed" the mechanical audio.
 * Instead: we pass AUDIO_ATTACHED + AUDIO_KIND + AUDIO_TYPE into the prompt
 * and force a smart follow-up question about the sound characteristics.
 */
async function transcribeAudioSmart(audioBase64, locale, audioKind = "car_sound") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

  const kind = String(audioKind || "car_sound").toLowerCase().trim();
  const isVoice = kind === "voice";

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const res = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          response_format: "verbose_json",
          prompt:
            "Audio may be non-speech automotive sounds (engine/brakes). If no clear spoken words, keep text extremely short or empty. Do not invent smells.",
          language: String(locale || "").split("-")[0] || undefined,
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const speechEst = estimateSpeechFromWhisperVerbose(res);
    const rawText = String(res?.text || "").trim();

    // For non-voice (car_sound): keep transcript ONLY if it looks like actual speech.
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

    // Voice flow
    if (rawText.length > 240) {
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
   PARSER: DIAG_JSON + FINAL_ANSWER
========================================================= */
function extractDiagAndAnswer(raw = "") {
  const text = String(raw || "").trim();

  const diagMatch = text.match(/DIAG_JSON\s*:\s*({[\s\S]*?})\s*FINAL_ANSWER\s*:/i);
  const answerMatch = text.match(/FINAL_ANSWER\s*:\s*([\s\S]*)$/i);

  let diag = null;
  let finalAnswer = "";

  if (diagMatch && diagMatch[1]) {
    try {
      diag = JSON.parse(diagMatch[1]);
    } catch {
      diag = null;
    }
  }

  if (answerMatch && answerMatch[1]) {
    finalAnswer = String(answerMatch[1]).trim();
  }

  if (!finalAnswer) finalAnswer = text;
  return { diag, finalAnswer };
}

/* =========================================================
   HARD GUARD: prevent ZIP/GPS/shop talk when PLACES_INTENT:false
========================================================= */
function violatesNoPlaces(reply = "") {
  const t = String(reply || "").toLowerCase();
  const bad = [
    // EN
    "zip","zipcode","postal","postcode","gps","near me","nearby","closest","google maps","maps","address","location",
    "area","neighborhood","district","city","town","where are you",

    // AR
    "ورشة","ورش","ميكانيك","ميكانيكي","كراج","خرائط","خريطة","لوكيشن","عنوان","موقعك","حدد موقعك",
    "رمز بريدي","zip","gps","قريب","اقرب","أقرب",
    "منطقة","المنطقة","حي","الحي","مدينة","المحافظة","وين انت","وينه","دلني","اشرلي","حدد المنطقة","حدد الحي"
  ];
  return bad.some((w) => t.includes(w));
}

/* =========================================================
   REFUSAL GUARD
========================================================= */
function looksLikeRefusal(text = "") {
  const t = String(text || "").toLowerCase();
  const patterns = [
    "i can't assist", "i cannot assist", "i'm sorry, i can't", "i’m sorry, i can’t",
    "cannot help with that request", "can't help with that", "not able to help",
    "policy", "violat", "cannot comply", "i can't provide"
  ];
  return patterns.some((p) => t.includes(p));
}

function safeFallbackReply(locale = "en", userText = "") {
  const isAr = String(locale || "").toLowerCase().startsWith("ar");
  return isAr
    ? "وصلتني الأعراض/المرفقات. خلّيني أمشي وياك بطريقة ميكانيكي: رجفة + طقطقة عند التسارع غالباً تكون يا إمّا misfire (بواجي/كويلات)، أو مشكلة وقود/هواء (MAF/فلتر/بخاخ)، أو طرق/دق بسبب وقود/توقيت، وأحياناً قواعد مكينة إذا الاهتزاز قوي. سؤالين سريعين حتى أحدد: هل لمبة Check Engine شغّالة؟ وهل الصوت يشبه (تك تك سريع) لو (دق ثقيل)؟ وإذا تقدر، قلّي سنة السيارة ونوعها."
    : "I got your symptoms/attachments. Let’s do this like a real mechanic: shaking + a rattle/knock on acceleration is commonly misfire (plugs/coils), fuel/air imbalance (MAF/filter/injectors), true knock/ping (fuel/timing/carbon), or sometimes engine mounts if the vibration is harsh. Two quick questions: Is the Check Engine light on? And is the sound more like a fast ticking or a deep knock? If you can, tell me the year/make/model.";
}

/* =========================================================
   PLACES: formatting verified results for the model
========================================================= */
function formatWorkshopsForContext(workshops = []) {
  const list = Array.isArray(workshops) ? workshops : [];
  const top = list.slice(0, 6);

  const lines = top.map((w, idx) => {
    const name = w?.name || w?.title || "Workshop";
    const addr = w?.address || w?.formatted_address || w?.vicinity || "";
    const phone = w?.phone || w?.formatted_phone_number || "";
    const rating = w?.rating ? `rating:${w.rating}` : "";
    const url = w?.maps_url || w?.google_maps_url || w?.googleMapsUri || w?.url || "";
    const website = w?.website || w?.websiteUri || "";
    const price = w?.price_hint || "";

    const parts = [name, addr, phone, rating, price, url, website].filter(Boolean).join(" | ");
    return `${idx + 1}) ${parts}`;
  });

  return lines.join("\n");
}

function formatWorkshopsForUser(workshops = [], locale = "en") {
  const isAr = String(locale || "").toLowerCase().startsWith("ar");
  const list = Array.isArray(workshops) ? workshops : [];
  const top = list.slice(0, 5);

  const lines = top.map((w, i) => {
    const name = w?.name || w?.title || (isAr ? "ورشة" : "Shop");
    const addr = w?.address || w?.formatted_address || w?.vicinity || "";
    const phone = w?.phone || w?.formatted_phone_number || "";
    const url = w?.maps_url || w?.google_maps_url || w?.googleMapsUri || w?.url || "";
    const price = w?.price_hint || "";

    const bits = [
      `${i + 1}) ${name}`,
      addr ? (isAr ? `العنوان: ${addr}` : `Address: ${addr}`) : "",
      phone ? (isAr ? `هاتف: ${phone}` : `Phone: ${phone}`) : "",
      price ? price : "",
      url ? (isAr ? `خرائط: ${url}` : `Maps: ${url}`) : "",
    ].filter(Boolean);

    return bits.join("\n");
  });

  return lines.join("\n\n");
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "");
  const history = Array.isArray(body.history) ? body.history : [];

  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location);
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
          ? "اكتب الأعراض أو أرسل صورة/صوت، وأنا أبدأ معك."
          : "Send symptoms or attach photo/audio and I’ll start.",
        locale,
        workshops_count: 0,
        ...(debugMode ? { debug: { stage: "empty_input" } } : {}),
      };
    }

    // ===== AUDIO (smart) =====
    const audioAttached = Boolean(audio_base_64);
    const audioSmart = await transcribeAudioSmart(audio_base_64, locale, audioKindFinal);
    let voiceText = audioSmart.ok ? String(audioSmart.text || "").trim() : "";
    const audioType = audioSmart.audio_type || "none";

    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // For diagnosis text input: include voiceText only if it's real speech (voice or speech detected)
    const includeVoiceText =
      audioType === "speech" || audioType === "speech_detected_in_car_sound";

    const fullInput = `${text} ${includeVoiceText ? voiceText : ""}`.trim();

    // ===== INTENT (HARD GATE) =====
    const diagnosisLikely = looksLikeDiagnosisText(fullInput || text);

    const placesFollowUp = looksLikePlacesFollowUp(history) && looksLikeLocationOnlyText(text);
    const placesRequested = looksLikePlacesRequest(text);

    const placesIntent = Boolean((placesRequested || placesFollowUp) && !diagnosisLikely);

    const placesQuery = placesFollowUp ? `mechanic near ${text}` : (fullInput || text);

    // ===== ENGINE CONTEXT (Option B) =====
    const enginePack = buildEngineContext(fullInput || text);
    const engineDetected = enginePack?.engine || null;
    const engineVehicle = enginePack?.vehicle || {};
    const enginePatterns = Array.isArray(enginePack?.patterns) ? enginePack.patterns : [];
    const engineConfidence = enginePack?.confidence || "low";

    // Rank & match issues against user symptoms
    const matchedEngineIssues = engineDetected ? rankEngineIssues(fullInput || text, enginePatterns) : [];

    // ===== SEARCH (KB always ok; places only if allowed) =====
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

    // ✅ Places direct list
    if (placesIntent && VERIFIED_WORKSHOPS.length > 0) {
      const isAr = String(locale || "").toLowerCase().startsWith("ar");
      return {
        ok: true,
        reply: isAr
          ? `تفضل هذه ورش قريبة حسب طلبك:\n\n${formatWorkshopsForUser(VERIFIED_WORKSHOPS, locale)}`
          : `Here are nearby shops:\n\n${formatWorkshopsForUser(VERIFIED_WORKSHOPS, locale)}`,
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

    // ✅ Places zero results (no loop)
    if (placesIntent && VERIFIED_WORKSHOPS.length === 0) {
      const isAr = String(locale || "").toLowerCase().startsWith("ar");
      return {
        ok: true,
        reply: isAr
          ? (placesFollowUp
              ? "ما طلعت نتائج واضحة لهذا الموقع. جرّب تكتبها أدق (مثال: المنصور – شارع 14 رمضان / الكاظمية – قرب باب المراد) أو فعّل GPS داخل التطبيق. بعدها أعطيك ورش مع روابط خرائط."
              : "أقدر أطلع لك ورش قريبة، بس لازم واحد من هذني: (1) فعّل GPS داخل التطبيق واسمح بالموقع، أو (2) اكتب اسم المنطقة/الشارع بوضوح (مثلاً: الكاظمية، المنصور، شارع الرشيد). بعدها أرجع لك أفضل ورش مع روابط خرائط.")
          : (placesFollowUp
              ? "No clear results for that area. Please provide a more specific street/landmark or enable GPS in the app, then I’ll return shops with Maps links."
              : "I can show nearby shops, but I need either: (1) GPS enabled in the app (allow location), or (2) your area/street. Then I’ll return top shops with Maps links."),
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

    // ===== BUILD STRICT CONTEXT =====
    const audioNote = audioAttached
      ? `AUDIO_NOTE: AUDIO_ATTACHED=true. AUDIO_KIND=${audioKindFinal || "car_sound"}. If AUDIO_KIND is car_sound/non_speech, DO NOT pretend you analyzed the waveform. Instead ask smart follow-up questions about sound character (tick/rattle/knock/squeal/grind) and timing (cold/hot, under load vs idle).`
      : "";

    const engineContextText = `
ENGINE_CONTEXT (US engine intelligence):
- VEHICLE_MENTION: ${JSON.stringify(engineVehicle)}
- DETECTED_ENGINE: ${engineDetected ? engineDetected : "null"}
- ENGINE_MATCH_CONFIDENCE: ${engineDetected ? engineConfidence : "none"}
- ENGINE_PATTERNS_JSON: ${JSON.stringify(enginePatterns)}
- MATCHED_ENGINE_ISSUES_JSON (ranked by symptom match): ${JSON.stringify(matchedEngineIssues)}

RULES:
- If DETECTED_ENGINE is not null and matched issues align with the symptom pattern, you MAY mention the engine explicitly to the user.
- If engine is uncertain or mismatch, do NOT guess. Ask 1 targeted question to confirm year/make/model/engine size only if it materially changes the diagnosis.
- Use matched issues to enrich diagnosis (mechanism + common failure pattern + best confirmation check).
`.trim();

    const strictText = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ABSOLUTE_RULES:
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city, NEVER mention nearby shops/maps.
- Diagnosis only. No place-search behavior.

${engineContextText}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}
WORKSHOPS_CONTEXT_TEXT:
${formatWorkshopsForContext(VERIFIED_WORKSHOPS)}

AUDIO_ATTACHED: ${audioAttached ? "true" : "false"}
AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${includeVoiceText ? voiceText : ""}

${audioNote}

USER_INPUT: ${text.trim()}
`.trim();

    const messageContent = [{ type: "text", text: strictText }];

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
    }

    // =========================================================
    // STAGE 1: DIAG_JSON + FINAL_ANSWER
    // =========================================================
    const response1 = await withRetry(
      () =>
        withTimeout(
          client.chat.completions.create({
            model: process.env.FIXLENS_MODEL || "gpt-4o",
            messages: [
              { role: "system", content: buildDoctorSystemPrompt() },
              ...history.slice(-6),
              { role: "user", content: messageContent },
              {
                role: "user",
                content:
                  "Return EXACTLY:\nDIAG_JSON: {valid JSON}\nFINAL_ANSWER: <final answer>\nNo extra text.\nFINAL_ANSWER must sound like a real mechanic/diagnostic engineer. Use engine intelligence if relevant. Follow the system prompt rules for questions (ask only what matters).",
              },
            ],
            temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.55),
            max_tokens: Number(process.env.FIXLENS_MAX_TOKENS || 900),
          }),
          Number(process.env.CHAT_TIMEOUT_MS || 25000),
          "chat_timeout"
        ),
      2
    );

    const raw1 = String(response1?.choices?.[0]?.message?.content || "").trim();

    // ✅ Refusal guard
    if (looksLikeRefusal(raw1)) {
      return {
        ok: true,
        reply: safeFallbackReply(locale, text),
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
                engineDetected,
                engineConfidence,
                engineVehicle,
                matchedEngineIssues_count: matchedEngineIssues.length,
              },
            }
          : {}),
      };
    }

    let { diag: diag1, finalAnswer: answer1 } = extractDiagAndAnswer(raw1);

    if (!diag1 || !diag1?.search_intent) {
      const fallback = answer1 || safeFallbackReply(locale, text);
      return {
        ok: true,
        reply: looksLikeRefusal(fallback) ? safeFallbackReply(locale, text) : fallback,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_no_diagjson",
                raw1,
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
                engineDetected,
                engineConfidence,
                engineVehicle,
                matchedEngineIssues_count: matchedEngineIssues.length,
              },
            }
          : {}),
      };
    }

    // ===== HARD GUARD: If no-places mode, block any ZIP/GPS/shop talk and force rewrite
    if (!placesIntent && violatesNoPlaces(answer1)) {
      const guardResponse = await withRetry(
        () =>
          withTimeout(
            client.chat.completions.create({
              model: process.env.FIXLENS_MODEL || "gpt-4o",
              messages: [
                { role: "system", content: buildDoctorSystemPrompt() },
                { role: "user", content: messageContent },
                {
                  role: "user",
                  content:
                    "PLACES_INTENT is false. Rewrite the answer as diagnosis only. Do NOT ask for ZIP/GPS/city. Do NOT mention shops/maps. Follow the system prompt for style and questions. Keep it clear and helpful (not too short).",
                },
              ],
              temperature: 0.35,
              max_tokens: 750,
            }),
            Number(process.env.CHAT_TIMEOUT_MS || 25000),
            "chat_timeout"
          ),
        2
      );

      const forced = String(guardResponse?.choices?.[0]?.message?.content || "").trim();
      if (forced) answer1 = forced;
    }

    // ✅ If model still refused in FINAL_ANSWER
    if (looksLikeRefusal(answer1)) {
      answer1 = safeFallbackReply(locale, text);
    }

    // =========================================================
    // STAGE 2 (Optional): technical search refinement only
    // =========================================================
    const needsSearch = Boolean(diag1?.search_intent?.needs_search);
    const searchQuery = String(diag1?.search_intent?.query || "").trim();

    const queryLooksPlacey = looksLikePlacesRequest(searchQuery);

    if (needsSearch && searchQuery.length >= 3 && !(!placesIntent && queryLooksPlacey)) {
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

      const VERIFIED_DATA_2 = Array.isArray(searchPack2?.verified_data) ? searchPack2.verified_data : [];
      const VERIFIED_WORKSHOPS_2 = Array.isArray(searchPack2?.verified_workshops)
        ? searchPack2.verified_workshops
        : [];

      const refineStrict = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ENGINE_CONTEXT (carry):
- DETECTED_ENGINE: ${engineDetected ? engineDetected : "null"}
- ENGINE_MATCH_CONFIDENCE: ${engineDetected ? engineConfidence : "none"}
- VEHICLE_MENTION: ${JSON.stringify(engineVehicle)}
- MATCHED_ENGINE_ISSUES_JSON: ${JSON.stringify(matchedEngineIssues)}
- ENGINE_PATTERNS_JSON: ${JSON.stringify(enginePatterns)}

DIAG_JSON_FROM_STAGE1: ${JSON.stringify(diag1)}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA_2)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS_2)}
WORKSHOPS_CONTEXT_TEXT:
${formatWorkshopsForContext(VERIFIED_WORKSHOPS_2)}

ABSOLUTE_RULES:
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city, NEVER mention shops/maps.

AUDIO_ATTACHED: ${audioAttached ? "true" : "false"}
AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${includeVoiceText ? voiceText : ""}

USER_INPUT: ${text.trim()}
`.trim();

      const response2 = await withRetry(
        () =>
          withTimeout(
            client.chat.completions.create({
              model: process.env.FIXLENS_MODEL || "gpt-4o",
              messages: [
                { role: "system", content: buildDoctorSystemPrompt() },
                { role: "user", content: [{ type: "text", text: refineStrict }] },
                {
                  role: "user",
                  content:
                    "Write ONLY the final answer in the required language. Follow the system prompt (professional mechanic tone, no fluff). Use engine intelligence when it matches. Ask only the questions that materially change the diagnosis.",
                },
              ],
              temperature: 0.45,
              max_tokens: Number(process.env.FIXLENS_MAX_TOKENS || 700),
            }),
            Number(process.env.CHAT_TIMEOUT_MS || 25000),
            "chat_timeout"
          ),
        2
      );

      let reply2 =
        String(response2?.choices?.[0]?.message?.content || "").trim() ||
        answer1 ||
        safeFallbackReply(locale, text);

      if (looksLikeRefusal(reply2)) reply2 = safeFallbackReply(locale, text);
      if (!placesIntent && violatesNoPlaces(reply2)) reply2 = answer1;

      return {
        ok: true,
        reply: reply2,
        locale,
        workshops_count: VERIFIED_WORKSHOPS_2.length,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_refined",
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
                diag1,
                searchQuery,
                engineDetected,
                engineConfidence,
                engineVehicle,
                matchedEngineIssues_count: matchedEngineIssues.length,
              },
            }
          : {}),
      };
    }

    return {
      ok: true,
      reply: answer1 || safeFallbackReply(locale, text),
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
              engineDetected,
              engineConfidence,
              engineVehicle,
              matchedEngineIssues_count: matchedEngineIssues.length,
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
