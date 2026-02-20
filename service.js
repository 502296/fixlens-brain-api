import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LOCATION NORMALIZER (fix "Global" / empty bugs)
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
   LANGUAGE (stable + overrides bad client locale)
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  // light hint: Spanish/French etc (Latin) stay "en" here, model can still reply
  return "en";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v || v.toLowerCase() === "auto") return "";
  return v;
}

/**
 * IMPORTANT:
 * - If client sends locale="en" but the latest user text is Arabic, override to Arabic.
 * - Locale must follow the user's latest message, not history.
 */
function inferLocale({ locale, text }) {
  const normalized = normalizeLocale(locale);
  const detected = detectTextLanguage(text || "") || "en";

  if (!normalized) return detected;

  // If client says "en" but user text is clearly Arabic/ru/zh/ja/ko: override
  const normShort = normalized.split("-")[0].toLowerCase();
  if (normShort === "en" && detected !== "en") return detected;

  // If client gives something else, trust it.
  return normalized;
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
   PLACES INTENT (typed text ONLY)
========================================================= */
function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();

  const shop = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "ورشة",
    "ورش",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "وين",
  ];

  const parts = [
    "auto parts",
    "car parts",
    "parts store",
    "autozone",
    "o'reilly",
    "oreilly",
    "advance auto",
    "napa",
    "hardware store",
    "tool store",
    "tools store",
    "قطع غيار",
    "محل قطع",
    "محل قطع غيار",
    "محل ادوات",
    "محل أدوات",
    "ادوات",
    "أدوات",
  ];

  return shop.some((w) => t.includes(w)) || parts.some((w) => t.includes(w));
}

function looksLikeLocationHintOnly(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  if (/^\d{5}(-\d{4})?$/.test(t)) return true;
  if (/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t)) return true;

  const hints = [
    "i am in",
    "i'm in",
    "my location",
    "zip",
    "city",
    "state",
    "انا في",
    "أني في",
    "المنطقة",
    "الحي",
    "المدينة",
    "المحافظة",
    "الولاية",
  ];
  return hints.some((w) => t.includes(w));
}

function lastUserAskedForPlaces(history = []) {
  if (!Array.isArray(history) || history.length === 0) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;

    const c = msg?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) {
      text = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
    }

    text = String(text || "").trim();
    if (!text) continue;

    return looksLikePlacesRequest(text);
  }
  return false;
}

/* =========================================================
   AUDIO: Detect speech vs non-speech (ENGINE/BRAKES)
   - Uses verbose_json segments no_speech_prob when available
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
 * Silicon Valley Rule (your request):
 * If user sends audio -> treat as mechanical sound FIRST.
 * Do NOT assume road vibration unless user says so.
 *
 * Implementation:
 * - Default audioKind = "car_sound"
 * - Even if Whisper returns words, we don't let that override user's intent.
 */
async function transcribeAudioSmart(audioBase64, locale, audioKind = "") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const langShort = String(locale || "").split("-")[0] || undefined;

    const res = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          response_format: "verbose_json",
          prompt:
            "Audio may be non-speech automotive sounds (engine/brakes/rattle). If no clear spoken words, keep text empty. Do not invent smells.",
          language: langShort,
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = String(res?.text || "").trim();

    // Default behavior: treat as car sound unless explicitly "voice"
    const kind = String(audioKind || "").toLowerCase().trim();
    const treatAsCarSound = kind !== "voice"; // default true

    const speechEst = estimateSpeechFromWhisperVerbose(res);

    // Drop garbage transcripts
    if (text.length > 240) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // If we treat as car sound -> do NOT use transcript
    if (treatAsCarSound) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // Voice mode: use transcript if it looks like speech
    if (speechEst.hasSpeech === false) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    if (speechEst.hasSpeech === true && text) {
      return { ok: true, text, audio_type: "speech", speech_score: speechEst.score };
    }

    const looksWordy = /[a-zA-Z\u0600-\u06FF]{3,}/.test(text);
    if (text && text.length <= 80 && looksWordy) {
      return { ok: true, text, audio_type: "speech_maybe", speech_score: speechEst.score };
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
   OUTPUT FORMATTERS (clean)
========================================================= */
function formatPlaceLine(w, i, locale) {
  const ar = String(locale || "").toLowerCase().startsWith("ar");
  const name = w?.name || (ar ? "مكان" : "Place");
  const address = w?.address ? (ar ? `\nالعنوان: ${w.address}` : `\nAddress: ${w.address}`) : "";
  const rating =
    w?.rating && Number(w.rating) > 0
      ? ar
        ? `\nالتقييم: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} مراجعة)` : ""}`
        : `\nRating: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} reviews)` : ""}`
      : "";
  const phone = w?.phone ? (ar ? `\nالهاتف: ${w.phone}` : `\nPhone: ${w.phone}`) : "";
  const maps = w?.maps_url ? (ar ? `\nخرائط Google: ${w.maps_url}` : `\nGoogle Maps: ${w.maps_url}`) : "";

  return `${i + 1}) ${name}${address}${rating}${phone}${maps}`;
}

function buildPlacesReply(workshops, locale) {
  const ar = String(locale || "").toLowerCase().startsWith("ar");
  if (!Array.isArray(workshops) || workshops.length === 0) {
    return ar
      ? "ما لكيت نتائج قريبة الآن. فعّل GPS أو اكتب ZIP/المدينة + الولاية (مثال: 40218 أو Louisville, KY)."
      : "No nearby results right now. Enable GPS or send ZIP / City + State (e.g., 40218 or Louisville, KY).";
  }

  const lines = workshops.slice(0, 5).map((w, i) => formatPlaceLine(w, i, locale)).join("\n\n");
  return ar
    ? `هذه نتائج قريبة حسب موقعك:\n\n${lines}\n\nإذا تكتب نوع الطلب (قطع غيار/إطارات/فرامل/ميكانيك) أرتّب لك نتائج أدق.`
    : `Here are nearby results based on your location:\n\n${lines}\n\nTell me what you need (parts/tires/brakes/mechanic) and I’ll refine it.`;
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "");
  const history = Array.isArray(body.history) ? body.history : [];

  // Locale must follow latest user text (override bad client locale)
  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  // Recommended: "voice" | "engine" | "brakes" | "car_sound"
  // Silicon rule: if not "voice" -> treat as car sound
  const audio_kind = String(body.audio_kind || "car_sound").trim();

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
    const audioSmart = await transcribeAudioSmart(audio_base_64, locale, audio_kind);
    let voiceText = audioSmart.ok ? String(audioSmart.text || "").trim() : "";
    const audioType = audioSmart.audio_type || "none";

    // Prevent smell hallucination from transcript
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // IMPORTANT: If audio is NON-SPEECH -> do NOT mix transcript
    const fullInput = `${text} ${audioType === "speech" || audioType === "speech_maybe" ? voiceText : ""}`.trim();

    // ===== PLACES INTENT (typed text only + continuation) =====
    const typedPlaces = looksLikePlacesRequest(text);
    const priorPlaces = lastUserAskedForPlaces(history);
    const locHintOnly = looksLikeLocationHintOnly(text);
    const placesIntent = typedPlaces || (priorPlaces && locHintOnly);

    // ===== SEARCH =====
    const searchPack = await withRetry(
      () =>
        withTimeout(
          performSearch(fullInput || text, user_location, {
            locale,
            allowPlaces: placesIntent,
            placesRadiusMeters: Number(body.places_radius_meters || 25000),
          }),
          Number(process.env.SEARCH_TIMEOUT_MS || 15000),
          "search_timeout"
        ),
      2
    );

    const VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
    const VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops) ? searchPack.verified_workshops : [];

    // ===== DIRECT PLACES RESPONSE =====
    if (placesIntent) {
      const reply = buildPlacesReply(VERIFIED_WORKSHOPS, locale);
      return {
        ok: true,
        reply,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places",
                typedPlaces,
                priorPlaces,
                locHintOnly,
                placesIntent,
                audioType,
                speech_score: audioSmart.speech_score,
                has_places_key: Boolean(process.env.GOOGLE_PLACES_API_KEY),
                location_type: typeof user_location,
              },
            }
          : {}),
      };
    }

    // ===== DIAGNOSIS MODE =====
    const messageContent = [];

    const audioNote =
      audio_base_64
        ? `AUDIO_NOTE: ${
            audioType === "non_speech" || !voiceText
              ? `NON_SPEECH_CAR_SOUND (${audio_kind || "car_sound"})`
              : `SPEECH_PRESENT (${audioType})`
          }.`
        : "AUDIO_NOTE: none.";

    // 🚫 CRITICAL FIX:
    // We explicitly pass PLACES_INTENT + VERIFIED_WORKSHOPS_JSON
    // and we ORDER the model: if PLACES_INTENT=false, do NOT mention workshops/nearby.
    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}
PLACES_INTENT: ${placesIntent}
WORKSHOPS_COUNT: ${VERIFIED_WORKSHOPS.length}

HARD_RULES:
- Reply ONLY in LOCALE language.
- If PLACES_INTENT is false: never mention workshops/nearby/mechanics/ZIP/GPS.
- Only talk about workshops if PLACES_INTENT is true AND VERIFIED_WORKSHOPS_JSON has items.
- Never say “I can’t provide nearby mechanics” unless PLACES_INTENT is true and the workshops list is empty.
- Never invent smells from audio. Only mention smell if user typed it.

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${(audioType === "speech" || audioType === "speech_maybe") ? voiceText : ""}
${audioNote}

USER_INPUT: ${text.trim()}`,
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
    }

    const response = await withRetry(
      () =>
        withTimeout(
          client.chat.completions.create({
            model: process.env.FIXLENS_MODEL || "gpt-4o",
            messages: [
              { role: "system", content: buildDoctorSystemPrompt() },

              // Keep a short window of history, but don't let it override LOCALE.
              ...history.slice(-6),

              { role: "user", content: messageContent },
            ],
            temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.12),
            max_tokens: Number(process.env.FIXLENS_MAX_TOKENS || 900),
          }),
          Number(process.env.CHAT_TIMEOUT_MS || 25000),
          "chat_timeout"
        ),
      2
    );

    const reply =
      String(response?.choices?.[0]?.message?.content || "").trim() ||
      (String(locale || "").toLowerCase().startsWith("ar")
        ? "صار خلل مؤقت، أعد المحاولة."
        : "Temporary issue, please retry.");

    return {
      ok: true,
      reply,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      ...(debugMode ? { debug: { stage: "ok", placesIntent, audioType, speech_score: audioSmart.speech_score } } : {}),
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
