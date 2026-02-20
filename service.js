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
   LANGUAGE (stable + override bad locale)
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");

  // Arabic (including extended blocks)
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  // Russian/Cyrillic
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Chinese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  // Japanese
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Korean
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";

  // Simple Latin language hints (very light)
  // If you want, we can expand later, but keep it safe now.
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

  // If user typed in a clear non-English script, trust that always.
  // This fixes cases where Flutter sends locale="en" by mistake.
  if (detected && detected !== "en") return detected;

  // If locale is provided and not empty, use it.
  if (normalized) return normalized;

  // Fallback
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

/* =========================================================
   AUDIO: Non-speech first (ENGINE/BRAKES) + optional speech
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
 * Smart transcription:
 * - Default: treat audio as NON-SPEECH car sound (engine/mechanical)
 * - Only treat as speech when audio_kind === "voice"
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

    // If it's not "voice", we still run Whisper in verbose mode ONLY to detect "no_speech_prob"
    // BUT we will NOT use transcript as user intent.
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

    // HARD DEFAULT: audio is a car sound unless explicitly "voice"
    if (!isVoice) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // If voice mode: guard against garbage transcripts
    if (rawText.length > 240) {
      return { ok: true, text: "", audio_type: "speech_garbage", speech_score: speechEst.score };
    }

    // If segments say non-speech, drop it even in voice mode
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

  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  // "voice" | "engine" | "brakes" | "car_sound"
  // IMPORTANT: default to car_sound if audio exists and audio_kind missing
  const audio_kind = String(body.audio_kind || "").trim();
  const audioKindFinal = audio_base_64 ? (audio_kind || "car_sound") : "";

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

    // Extra guard: prevent smell hallucination
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // IMPORTANT: we only mix transcript if it's VOICE (speech)
    const fullInput = `${text} ${audioType === "speech" ? voiceText : ""}`.trim();

    // ===== PLACES INTENT (typed text ONLY) =====
    const placesIntent = looksLikePlacesRequest(text);

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
        ? `\nAUDIO_NOTE: PRIMARY_MECHANICAL_SOUND (${audioKindFinal || "car_sound"}). Treat audio as mechanical sound first. Do NOT invent smells. Ask ONE short question only if needed.`
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Respond ONLY in LOCALE language.
- Use user's typed symptoms as primary truth.
- No filler. No invention.
- Pick ONE primary diagnosis and lead with it.
- Ask at most ONE question only if it changes diagnosis.

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
AUDIO_KIND: ${audioKindFinal || ""}
AUDIO_TYPE: ${audioType}
AUDIO_TRANSCRIPT: ${audioType === "speech" ? voiceText : ""}${audioNote}

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
      ...(debugMode ? { debug: { stage: "ok", audioType, speech_score: audioSmart.speech_score } } : {}),
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
