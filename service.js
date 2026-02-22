// service.js — FixLens "Doctor Brain" v2.3 (Places Route + Strong Multilingual + Engine Layer B)
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
  return issues.slice(0, 6);
}

function buildEngineContext(text = "") {
  const info = extractVehicleInfo(text);
  const detectedEngine = detectEngineFromVehicle(info.make, info.model, info.year);
  if (!detectedEngine) return { vehicle: info, engine: null, patterns: [] };

  const patterns = findEnginePatterns(detectedEngine);
  return { vehicle: info, engine: detectedEngine, patterns };
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
   INTENT: DIAGNOSIS vs PLACES (Strong routing)
========================================================= */
function looksLikeDiagnosisText(input = "") {
  const t = String(input || "").toLowerCase();
  const words = [
    "noise","sound","rattle","knock","ticking","click","clunk","grind","squeal",
    "vibration","shake","misfire","stall","idle","engine","brake","steering",
    "overheat","smoke","leak","check engine","p0",
    "صوت","طقطقة","طرطقة","تك تك","نق","خبط","خشخشة","صرير","زقزقة",
    "رجفة","اهتزاز","هزة","تقطيع","تنتيع","تفتفة",
    "محرك","مكينة","فرامل","دركسون","ستيرنغ",
    "حرارة","سخونة","دخان","تهريب","تسريب","لمبة","تشيك"
  ];
  return words.some((w) => t.includes(w));
}

function looksLikeNearbyRequest(input = "") {
  const t = String(input || "").toLowerCase();
  const nearby = ["near me","nearby","closest","around me","اقرب","أقرب","بالقرب","قريب","حولّي","حولي","قريبة"];
  return nearby.some((w) => t.includes(w));
}

function looksLikeShopOrPartsWords(input = "") {
  const t = String(input || "").toLowerCase();
  const strong = [
    "mechanic","garage","auto repair","repair shop","car repair",
    "auto parts","car parts","parts store","tool store","hardware store",
    "autozone","o'reilly","oreilly","advance auto","napa",
    "workshop","shop",
    "ورشة","ورش","ميكانيك","ميكانيكي","كراج",
    "قطع غيار","محل قطع","محل قطع غيار","محل ادوات","محل أدوات","ادوات","أدوات"
  ];
  return strong.some((w) => t.includes(w));
}

function looksLikeMapAddressWords(input = "") {
  const t = String(input || "").toLowerCase();
  const weak = [
    "address","location","map","google maps",
    "عنوان","موقع","خرائط","خريطة","لوكيشن",
    "zip","zipcode","postal","postcode","رمز بريدي"
  ];
  return weak.some((w) => t.includes(w));
}

// Your requested helper (kept as a strong alias)
function looksLikeShopSearch(text = "") {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("mechanic") ||
    t.includes("repair shop") ||
    t.includes("auto shop") ||
    t.includes("garage") ||
    t.includes("near me") ||
    t.includes("location") ||
    t.includes("workshop") ||
    t.includes("shop") ||
    t.includes("ورشة") ||
    t.includes("ميكانيكي") ||
    t.includes("كراج") ||
    t.includes("قريب") ||
    t.includes("عنوان") ||
    t.includes("قطع غيار") ||
    t.includes("محل قطع")
  );
}

function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();
  if (looksLikeNearbyRequest(t)) return true;
  if (looksLikeShopOrPartsWords(t)) return true;
  // If someone says "address/location/map" without shop words, it's ambiguous; keep it conservative
  if (looksLikeMapAddressWords(t) && looksLikeShopOrPartsWords(t)) return true;
  return false;
}

/* =========================================================
   AUDIO: Non-speech first + optional speech
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

    // Default: treat audio as NON-SPEECH car sound unless explicitly voice
    if (!isVoice) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

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
    "zip", "zipcode", "postal", "postcode", "gps", "near me", "nearby", "closest", "google maps",
    "ورشة", "ورش", "ميكانيك", "ميكانيكي", "كراج", "رمز بريدي", "حدد موقعك", "موقعك", "خرائط"
  ];
  return bad.some((w) => t.includes(w));
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
    const url = w?.maps_url || w?.google_maps_url || w?.url || "";
     const website = w?.website || w?.websiteUri || "";
    const price = w?.price_hint || "";
    const parts = [name, addr, phone, rating, price, url, website]
  .filter(Boolean)
  .join(" | ");
    return `${idx + 1}) ${parts}`;
  });

  return lines.join("\n");
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

  const placesRadiusMeters = Number(body.places_radius_meters || process.env.PLACES_RADIUS_METERS || 25000);

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
    const audioSmart = await transcribeAudioSmart(audio_base_64, locale, audioKindFinal);
    let voiceText = audioSmart.ok ? String(audioSmart.text || "").trim() : "";
    const audioType = audioSmart.audio_type || "none";

    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    const fullInput = `${text} ${audioType === "speech" ? voiceText : ""}`.trim();

    // ===== INTENT =====
    const diagnosisLikely = looksLikeDiagnosisText(fullInput || text);

    // Strong places request detection (your helper included)
    const placesRequested = looksLikePlacesRequest(text) || looksLikeShopSearch(text);

    // KEY FIX:
    // If the user explicitly asked for shops/parts/address, we allow places even if earlier conversation was diagnosis.
    // But we DO NOT mix: if message contains BOTH diagnosis + places, treat it as diagnosis first (your original rule).
    const messageHasDiagnosisNow = looksLikeDiagnosisText(text);
    const placesIntent = Boolean(placesRequested && !messageHasDiagnosisNow);

    // ===== ENGINE CONTEXT (Option B) =====
    const enginePack = buildEngineContext(fullInput || text);
    const engineDetected = enginePack?.engine || null;
    const engineVehicle = enginePack?.vehicle || {};
    const enginePatterns = Array.isArray(enginePack?.patterns) ? enginePack.patterns : [];

    // ===== SEARCH (KB always ok; places only if allowed) =====
    const searchPack = await withRetry(
      () =>
        withTimeout(
          performSearch(fullInput || text, user_location, {
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
    const VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops) ? searchPack.verified_workshops : [];

    // ===== PLACES FAST-PATH (NEW) =====
    // If placesIntent is true, we force a "workshop finder" answer. No refusing.
    if (placesIntent) {
      const shopsText = formatWorkshopsForContext(VERIFIED_WORKSHOPS);

      const placesStrict = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: true
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

VERIFIED_WORKSHOPS_TEXT:
${shopsText || "(none)"}

RULES:
- You are allowed to suggest nearby workshops/parts stores ONLY because PLACES_INTENT:true.
- If VERIFIED_WORKSHOPS_TEXT is (none), do NOT refuse. Ask ONE short question to narrow location (city/area) in the SAME language, and offer to search again.
- Output must be in the user language (LOCALE).
- Keep it helpful and human. No headings. No bullets. No numbering. (You may list shops as simple lines if present.)
`.trim();

      const responsePlaces = await withRetry(
        () =>
          withTimeout(
            client.chat.completions.create({
              model: process.env.FIXLENS_MODEL || "gpt-4o",
              messages: [
                { role: "system", content: buildDoctorSystemPrompt() },
                ...history.slice(-4),
                { role: "user", content: [{ type: "text", text: placesStrict }] },
                {
                  role: "user",
                  content:
                    "Write the best answer. If shops exist, show up to 5 options with name + address + phone if available. If none exist, ask for the city/area and offer to retry search. No extra text.",
                },
              ],
              temperature: 0.35,
              max_tokens: 650,
            }),
            Number(process.env.CHAT_TIMEOUT_MS || 25000),
            "chat_timeout"
          ),
        2
      );

      const placesReply =
        String(responsePlaces?.choices?.[0]?.message?.content || "").trim() ||
        (String(locale || "").toLowerCase().startsWith("ar")
          ? "أقدر أبحث لك عن ورش، بس قلّي أي مدينة/منطقة بالضبط؟"
          : "I can search for shops—what city/area should I use?");

      return {
        ok: true,
        reply: placesReply,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places_fast_path",
                diagnosisLikely,
                placesIntent,
                workshops: VERIFIED_WORKSHOPS.slice(0, 5),
              },
            }
          : {}),
      };
    }

    // ===== BUILD STRICT CONTEXT (DIAG PATH) =====
    const audioNote = audio_base_64
      ? `AUDIO_NOTE: PRIMARY_MECHANICAL_SOUND (${audioKindFinal || "car_sound"}). Treat audio as mechanical sound first. Do NOT invent smells.`
      : "";

    const engineContextText = `
ENGINE_CONTEXT (US engine intelligence):
- VEHICLE_MENTION: ${JSON.stringify(engineVehicle)}
- DETECTED_ENGINE: ${engineDetected ? engineDetected : "null"}
- ENGINE_PATTERNS_JSON: ${JSON.stringify(enginePatterns)}
RULE:
- If DETECTED_ENGINE is not null AND patterns match the symptom, you MAY mention the engine explicitly to the user (Option B).
- If engine is uncertain, do NOT guess. Ask at most one of your allowed questions to confirm (year/model/engine size).
`.trim();

    const strictText = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: false
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ABSOLUTE_RULES:
- PLACES_INTENT is false => NEVER ask for ZIP/GPS/city, NEVER mention nearby shops/maps.
- Diagnosis only. No place-search behavior.

${engineContextText}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: []  // blocked in diagnosis mode

AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${audioType === "speech" ? voiceText : ""}

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
                  "Return EXACTLY:\nDIAG_JSON: {valid JSON}\nFINAL_ANSWER: <final answer>\nNo extra text.\nFINAL_ANSWER must be mechanic-like, not cold-short, and not verbose. Ask max 2 questions only if they matter.",
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
    let { diag: diag1, finalAnswer: answer1 } = extractDiagAndAnswer(raw1);

    if (!diag1 || !diag1?.search_intent) {
      return {
        ok: true,
        reply:
          answer1 ||
          (String(locale || "").toLowerCase().startsWith("ar")
            ? "صار خلل مؤقت، أعد المحاولة."
            : "Temporary issue, please retry."),
        locale,
        workshops_count: 0,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_no_diagjson",
                raw1,
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent: false,
                engineDetected,
                engineVehicle,
              },
            }
          : {}),
      };
    }

    // HARD GUARD: no-places mode => block any ZIP/GPS/shop talk and force rewrite
    if (violatesNoPlaces(answer1)) {
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
                    "PLACES_INTENT is false. Rewrite FINAL_ANSWER as a real mechanic diagnosis. Do NOT ask for ZIP/GPS/city. Do NOT mention shops/maps. No headings/bullets/numbering. Ask max 2 questions only if essential. Keep it clear and helpful (not too short).",
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

    // =========================================================
    // STAGE 2 (Optional): technical search refinement only
    // =========================================================
    const needsSearch = Boolean(diag1?.search_intent?.needs_search);
    const searchQuery = String(diag1?.search_intent?.query || "").trim();

    const queryLooksPlacey = looksLikePlacesRequest(searchQuery) || looksLikeShopSearch(searchQuery);

    if (needsSearch && searchQuery.length >= 3 && !queryLooksPlacey) {
      const searchPack2 = await withRetry(
        () =>
          withTimeout(
            performSearch(searchQuery, user_location, {
              locale,
              allowPlaces: false,
              placesRadiusMeters,
            }),
            Number(process.env.SEARCH_TIMEOUT_MS || 15000),
            "search_timeout"
          ),
        2
      );

      const VERIFIED_DATA_2 = Array.isArray(searchPack2?.verified_data) ? searchPack2.verified_data : [];

      const refineStrict = `
STRICT_CONTEXT
LOCALE: ${locale}
PLACES_INTENT: false
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ENGINE_CONTEXT (carry):
- DETECTED_ENGINE: ${engineDetected ? engineDetected : "null"}
- VEHICLE_MENTION: ${JSON.stringify(engineVehicle)}
- ENGINE_PATTERNS_JSON: ${JSON.stringify(enginePatterns)}

DIAG_JSON_FROM_STAGE1: ${JSON.stringify(diag1)}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA_2)}

ABSOLUTE_RULES:
- PLACES_INTENT:false => NEVER ask for ZIP/GPS/city, NEVER mention shops/maps.

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
                    "Write ONLY the FINAL_ANSWER in the required language. No headings. No bullets. No numbers. Ask max 2 questions only if essential. Be decisive and mechanic-like. Keep it clear (not too short, not too long).",
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
        (String(locale || "").toLowerCase().startsWith("ar")
          ? "صار خلل مؤقت، أعد المحاولة."
          : "Temporary issue, please retry.");

      if (violatesNoPlaces(reply2)) reply2 = answer1;

      return {
        ok: true,
        reply: reply2,
        locale,
        workshops_count: 0,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_refined",
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent: false,
                diag1,
                searchQuery,
                engineDetected,
                engineVehicle,
              },
            }
          : {}),
      };
    }

    // Default: stage1 answer is enough
    return {
      ok: true,
      reply:
        answer1 ||
        (String(locale || "").toLowerCase().startsWith("ar")
          ? "صار خلل مؤقت، أعد المحاولة."
          : "Temporary issue, please retry."),
      locale,
      workshops_count: 0,
      ...(debugMode
        ? {
            debug: {
              stage: "ok_stage1",
              audioType,
              speech_score: audioSmart.speech_score,
              diagnosisLikely,
              placesIntent: false,
              diag1,
              engineDetected,
              engineVehicle,
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
