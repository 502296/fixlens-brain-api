// service.js
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
   LANGUAGE (stable + practical)
   - Do NOT trust Flutter locale when user text is clearly non-English.
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");

  // Arabic
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  // Russian/Cyrillic
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Chinese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  // Japanese
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Korean
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";

  // Quick hints for common Latin languages (best-effort)
  const lower = t.toLowerCase();
  if (/[áéíóúñ¿¡]/.test(lower) || /\b(que|porque|tengo|ruido|coche)\b/.test(lower)) return "es";
  if (/[àâçéèêëîïôùûüÿœ]/.test(lower) || /\b(je|j'ai|bruit|voiture|moteur)\b/.test(lower)) return "fr";
  if (/[äöüß]/.test(lower) || /\b(ich|geräusch|auto|motor)\b/.test(lower)) return "de";
  if (/[àèìòù]/.test(lower) || /\b(ho|rumore|auto|motore)\b/.test(lower)) return "it";
  if (/[ãõç]/.test(lower) || /\b(eu|carro|barulho|motor)\b/.test(lower)) return "pt";

  return "en";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  const low = v.toLowerCase();
  if (low === "auto" || low === "global") return "";
  return v;
}

/**
 * inferLocaleSmart:
 * - If text clearly indicates a language (Arabic/etc), that wins.
 * - Otherwise use provided locale if present.
 * - Else default to "en".
 */
function inferLocaleSmart({ locale, text }) {
  const textLang = detectTextLanguage(text || "");
  const normalized = normalizeLocale(locale);

  // If user wrote non-English, obey it even if Flutter sent "en"
  if (textLang && textLang !== "en") return textLang;

  // Otherwise trust explicit locale
  if (normalized) return normalized;

  return textLang || "en";
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
   PLACES INTENT (ONLY when user explicitly asks for shops/addresses)
========================================================= */
function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();

  const shop = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "tire shop",
    "tyre shop",
    "alignment",
    "balance",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "shop near",
    "find a shop",
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
    "وين أصلح",
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

/**
 * Symptom keywords: if user message contains these, it's NOT a "location-only" hint.
 * This prevents: "عندي صوت بالمحرك" from being treated as GPS/location follow-up.
 */
function hasSymptomWords(text = "") {
  const t = String(text || "").toLowerCase();
  const words = [
    "shake",
    "shaking",
    "vibration",
    "vibrate",
    "noise",
    "sound",
    "knock",
    "ticking",
    "squeal",
    "grind",
    "jerk",
    "stall",
    "misfire",
    "رجفة",
    "اهتزاز",
    "يرجف",
    "صوت",
    "طرق",
    "طقطقة",
    "صفير",
    "حك",
    "يطفى",
    "تقطيع",
    "نتعة",
  ];
  return words.some((w) => t.includes(w));
}

/**
 * STRICT "location-only" detector:
 * true only if the message is basically a location (zip/city/state/coords)
 * and does NOT contain symptom words.
 */
function looksLikeLocationHintOnly(text = "") {
  const raw = String(text || "").trim();
  const t = raw.toLowerCase();

  if (!t) return false;
  if (hasSymptomWords(t)) return false;

  // zip only
  if (/^\d{5}(-\d{4})?$/.test(t)) return true;

  // coordinates-like
  if (/^(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)$/.test(t)) return true;

  // "I am in ..." / "انا في ..." short forms
  const hints = ["i am in", "i'm in", "my location", "zip", "city", "state", "انا في", "أني في", "اني في"];
  const hasHint = hints.some((w) => t.includes(w));

  // If it's too long, it's probably not just a location
  if (raw.length > 45) return false;

  return hasHint;
}

/** finds the most recent USER message text in history */
function lastUserText(history = []) {
  if (!Array.isArray(history) || history.length === 0) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;
    const c = msg?.content;

    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
    }
  }
  return "";
}

/* =========================================================
   AUDIO: speech vs non-speech (ENGINE/BRAKES)
   - We assume audio is mechanical sound by default unless audio_kind === "voice"
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
 * transcribeAudioSmart:
 * - If audio_kind !== "voice", we treat it as mechanical sound and DO NOT trust transcript for diagnosis.
 * - We still run whisper to detect speech vs non-speech, but we drop transcript by default.
 */
async function transcribeAudioSmart(audioBase64, locale, audioKind = "") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

  const kind = String(audioKind || "").toLowerCase().trim();

  // Default: treat as car sound (mechanical) unless explicitly "voice"
  const treatAsMechanical = kind !== "voice";

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

    const text = String(res?.text || "").trim();
    const speechEst = estimateSpeechFromWhisperVerbose(res);

    // If transcript is too long => garbage
    if (text.length > 240) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // If we treat as mechanical, DO NOT use transcript for diagnosis
    if (treatAsMechanical) {
      return { ok: true, text: "", audio_type: "mechanical_sound", speech_score: speechEst.score };
    }

    // voice mode
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
  const price = w?.price_label
    ? ar
      ? `\nمستوى السعر: ${w.price_label}${w?.price_meaning ? ` (${w.price_meaning})` : ""}`
      : `\nPrice level: ${w.price_label}${w?.price_meaning ? ` (${w.price_meaning})` : ""}`
    : "";
  const maps = w?.maps_url ? (ar ? `\nخرائط Google: ${w.maps_url}` : `\nGoogle Maps: ${w.maps_url}`) : "";

  return `${i + 1}) ${name}${address}${rating}${phone}${price}${maps}`;
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

  // ✅ locale: prefer user text language
  let locale = inferLocaleSmart({ locale: body.locale, text });

  // ✅ location: string or object (gps)
  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  // OPTIONAL from Flutter: "voice" | "engine" | "brakes" | "car_sound"
  // Default to mechanical if audio exists and caller didn't specify.
  const audio_kind = String(body.audio_kind || "").trim() || (audio_base_64 ? "car_sound" : "");

  try {
    // Empty guard
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

    // extra guard: prevent smell hallucination
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // IMPORTANT:
    // - We never let audio transcript change intent (places) or override typed symptom.
    // - We only merge transcript into fullInput if user explicitly used "voice" mode.
    const fullInput = `${text} ${audioType === "speech" || audioType === "speech_maybe" ? voiceText : ""}`.trim();

    // ===== PLACES INTENT (strict) =====
    // Only if current message explicitly asks for shops/addresses.
    const typedPlaces = looksLikePlacesRequest(text);

    // Allow short "location-only" follow-up ONLY if previous user message was a places request.
    const prevUser = lastUserText(history);
    const prevWasPlaces = looksLikePlacesRequest(prevUser);

    const locHintOnly = looksLikeLocationHintOnly(text);
    const placesIntent = typedPlaces || (prevWasPlaces && locHintOnly);

    // ===== SEARCH (KB + Places when allowed) =====
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
                prevWasPlaces,
                locHintOnly,
                audioType,
                audio_kind,
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

    const audioPolicyLine =
      "If audio exists, prioritize it as mechanical sound from the car. Do NOT assume road vibration unless the user explicitly says road/tires/speed vibration.";

    const audioNote =
      audio_base_64
        ? `\nAUDIO_NOTE: ${audioType.toUpperCase()} (${audio_kind || "car_sound"}). ${audioPolicyLine} Do NOT invent smells. Use user's typed symptoms as primary truth.`
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Respond ONLY in LOCALE language.
- Use user's typed symptoms as primary truth.
- ${audioPolicyLine}
- No filler. No invention.
- Ask at most ONE question only if it changes diagnosis.

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${(audioType === "speech" || audioType === "speech_maybe") ? voiceText : ""}${audioNote}

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
              ...history.slice(-6),
              { role: "user", content: messageContent },
            ],
            temperature: Number(process.env.FIXLENS_TEMPERATURE || 0.15),
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
      ...(debugMode ? { debug: { stage: "ok", audioType, audio_kind, speech_score: audioSmart.speech_score } } : {}),
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
