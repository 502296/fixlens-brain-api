// service.js — FixLens "Doctor Brain" v2.2 (Hard Places Gate + No-Questions Guard + Strong Tone + Version Fingerprint)
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Version fingerprint (to confirm deploy is actually live)
const SERVICE_VERSION = "FIXLENS_SERVICE_v2.2_strong_2026-02-19";

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
    "near me","nearby","closest","around me",
    "اقرب","أقرب","بالقرب","قريب","حولّي","حولي","قريبة"
  ];
  return nearby.some((w) => t.includes(w));
}

function looksLikeShopOrPartsWords(input = "") {
  const t = String(input || "").toLowerCase();
  const strong = [
    "mechanic","garage","auto repair","repair shop","car repair",
    "auto parts","car parts","parts store","tool store","hardware store",
    "autozone","o'reilly","oreilly","advance auto","napa",
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

function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();
  if (looksLikeNearbyRequest(t)) return true;
  if (looksLikeShopOrPartsWords(t)) return true;
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
    "zip","zipcode","postal","postcode","gps","near me","nearby","closest","google maps","maps",
    "workshop","garage","mechanic","repair shop","auto repair","auto parts",
    "ورشة","ورش","ميكانيك","ميكانيكي","كراج","رمز بريدي","حدد موقعك","موقعك","خرائط"
  ];
  return bad.some((w) => t.includes(w));
}

/* =========================================================
   HARD GUARD: prevent questions unless HIGH risk
========================================================= */
function containsQuestion(reply = "") {
  const t = String(reply || "");
  return t.includes("?") || t.includes("؟");
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
        service_version: SERVICE_VERSION,
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

    // ===== INTENT (HARD GATE) =====
    const diagnosisLikely = looksLikeDiagnosisText(fullInput || text);
    const placesRequested = looksLikePlacesRequest(text);

    // HARD RULE: If it looks like diagnosis, DO NOT allow places mode.
    const placesIntent = Boolean(placesRequested && !diagnosisLikely);

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

    // ===== BUILD STRICT CONTEXT =====
    const audioNote = audio_base_64
      ? `AUDIO_NOTE: PRIMARY_MECHANICAL_SOUND (${audioKindFinal || "car_sound"}). Treat audio as mechanical sound first. Do NOT invent smells.`
      : "";

    // Strong tone rules (English in code; model responds in any LOCALE)
    const styleRules = `
STYLE_PROFILE:
- Tone: calm but severe, decisive, zero fluff.
- No long teaching.
- Do NOT guess random parts like spark plugs unless evidence supports it.
- Prefer one best diagnosis + one fast check.
- Avoid questions unless risk_level is HIGH.
`.trim();

    const strictText = `
STRICT_CONTEXT
SERVICE_VERSION: ${SERVICE_VERSION}
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

ABSOLUTE_RULES:
- Reply ONLY in LOCALE language.
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city, NEVER mention nearby shops/maps.
- No hallucinations. No invented smells/leaks/smoke/warnings.
- Ask ZERO questions by default. Only ask ONE question if risk_level is HIGH and the question changes safety decision.

${styleRules}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

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
                  "Return EXACTLY:\nDIAG_JSON: {valid JSON}\nFINAL_ANSWER: <final answer>\nNo extra text.",
              },
            ],
            temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.05),
            max_tokens: Number(process.env.FIXLENS_MAX_TOKENS || 900),
          }),
          Number(process.env.CHAT_TIMEOUT_MS || 25000),
          "chat_timeout"
        ),
      2
    );

    const raw1 = String(response1?.choices?.[0]?.message?.content || "").trim();
    let { diag: diag1, finalAnswer: answer1 } = extractDiagAndAnswer(raw1);

    // If parsing failed, return answer directly
    if (!diag1 || !diag1?.search_intent) {
      return {
        ok: true,
        reply:
          answer1 ||
          (String(locale || "").toLowerCase().startsWith("ar")
            ? "صار خلل مؤقت، أعد المحاولة."
            : "Temporary issue, please retry."),
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        service_version: SERVICE_VERSION,
        ...(debugMode
          ? {
              debug: {
                stage: "ok_no_diagjson",
                raw1,
                audioType,
                speech_score: audioSmart.speech_score,
                diagnosisLikely,
                placesIntent,
              },
            }
          : {}),
      };
    }

    // ===== HARD GUARDS =====
    const risk = String(diag1?.risk_level || "").toLowerCase().trim();

    // Block any ZIP/GPS/shop talk when placesIntent is false
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
                    "PLACES_INTENT is false. Rewrite FINAL_ANSWER as a decisive mechanic diagnosis. Do NOT ask for ZIP/GPS/city. Do NOT mention shops/maps. No headings/bullets/numbering. Keep it short and strong.",
                },
              ],
              temperature: 0,
              max_tokens: 650,
            }),
            Number(process.env.CHAT_TIMEOUT_MS || 25000),
            "chat_timeout"
          ),
        2
      );

      const forced = String(guardResponse?.choices?.[0]?.message?.content || "").trim();
      if (forced) answer1 = forced;
    }

    // Remove questions unless HIGH risk
    if (risk !== "high" && containsQuestion(answer1)) {
      const noQ = await withRetry(
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
                    "Rewrite FINAL_ANSWER with ZERO questions (no ? and no Arabic ؟). Do not ask anything. Give one main diagnosis, one immediate test, and clear drive/no-drive advice. No headings/bullets/numbers.",
                },
              ],
              temperature: 0,
              max_tokens: 600,
            }),
            Number(process.env.CHAT_TIMEOUT_MS || 25000),
            "chat_timeout"
          ),
        2
      );

      const forced2 = String(noQ?.choices?.[0]?.message?.content || "").trim();
      if (forced2) answer1 = forced2;
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
      const VERIFIED_WORKSHOPS_2 = Array.isArray(searchPack2?.verified_workshops) ? searchPack2.verified_workshops : [];

      const refineStrict = `
STRICT_CONTEXT
SERVICE_VERSION: ${SERVICE_VERSION}
LOCALE: ${locale}
PLACES_INTENT: ${placesIntent ? "true" : "false"}

DIAG_JSON_FROM_STAGE1: ${JSON.stringify(diag1)}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA_2)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS_2)}

ABSOLUTE_RULES:
- If PLACES_INTENT:false => NEVER ask for ZIP/GPS/city, NEVER mention shops/maps.
- Ask ZERO questions unless risk_level is HIGH.

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
                    "Write ONLY the FINAL_ANSWER in the required language. ZERO questions unless risk_level is HIGH. No headings. No bullets. No numbers. Be decisive and strong.",
                },
              ],
              temperature: 0,
              max_tokens: Number(process.env.FIXLENS_MAX_TOKENS || 650),
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

      if (!placesIntent && violatesNoPlaces(reply2)) reply2 = answer1;
      if (risk !== "high" && containsQuestion(reply2)) reply2 = answer1;

      return {
        ok: true,
        reply: reply2,
        locale,
        workshops_count: VERIFIED_WORKSHOPS_2.length,
        service_version: SERVICE_VERSION,
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
              },
            }
          : {}),
      };
    }

    // Default: stage1 answer
    return {
      ok: true,
      reply:
        answer1 ||
        (String(locale || "").toLowerCase().startsWith("ar")
          ? "صار خلل مؤقت، أعد المحاولة."
          : "Temporary issue, please retry."),
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      service_version: SERVICE_VERSION,
      ...(debugMode
        ? {
            debug: {
              stage: "ok_stage1",
              audioType,
              speech_score: audioSmart.speech_score,
              diagnosisLikely,
              placesIntent,
              risk_level: risk,
              diag1,
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
      service_version: SERVICE_VERSION,
    };
  }
}
