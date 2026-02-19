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
  if (typeof raw === "object") return raw; // GPS object
  return "";
}

/* =========================================================
   LANGUAGE (simple but stable)
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
  if (normalized) return normalized;
  return detectTextLanguage(text || "") || "en";
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
   INTENT: Places vs Diagnosis  (Silicon Valley routing)
========================================================= */
function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();

  // Workshops / mechanics / addresses
  const shop = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "shop near me",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "map",
    "maps",
    "google maps",
    "workshop",
    "garage near",
    "ميكانيك",
    "ميكانيكي",
    "ورشة",
    "ورش",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "وين أروح",
    "اريد ورشة",
    "اريد ميكانيكي",
  ];

  // Parts / tools stores
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

  // ZIP only or coordinates-like
  if (/^\d{5}(-\d{4})?$/.test(t)) return true;
  if (/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t)) return true;

  // Explicit location hint only (NOT generic "في")
  const hints = [
    "i am in ",
    "i'm in ",
    "my location",
    "my zip",
    "zip code",
    "city",
    "state",
    "انا في ",
    "أني في ",
    "موقعي",
    "الرمز البريدي",
    "zip",
  ];
  return hints.some((w) => t.includes(w));
}

function extractUserTextFromHistoryContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI content array: {type:"text", text:"..."}
    return content.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
  }
  return "";
}

// Only treat as "continuation of places flow" if the user asked for places VERY recently (last 1–2 user turns).
function lastUserAskedForPlacesRecently(history = [], maxUserTurnsBack = 2) {
  if (!Array.isArray(history) || history.length === 0) return false;

  let seenUserTurns = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;

    seenUserTurns += 1;
    const text = String(extractUserTextFromHistoryContent(msg?.content) || "").trim();
    if (text && looksLikePlacesRequest(text)) return true;

    if (seenUserTurns >= maxUserTurnsBack) break;
  }
  return false;
}

/* =========================================================
   AUDIO: Smart speech vs non-speech (ENGINE/BRAKES)
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

function normalizeAudioKind(raw) {
  const k = String(raw || "").trim().toLowerCase();
  if (!k) return "";
  // expected: "voice" | "engine" | "brakes" | "car_sound"
  return k;
}

// 핵심: إذا في Audio والـkind مو "voice" => نعتبره Mechanical Sound ونمنع Whisper يخرّب مسار التشخيص.
function isForcedMechanicalSound(audio_kind) {
  const k = normalizeAudioKind(audio_kind);
  return k === "engine" || k === "brakes" || k === "car_sound" || k === "sound" || k === "noise";
}

async function transcribeAudioSmart(audioBase64, locale, audio_kind = "") {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

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
            "This audio may be non-speech automotive mechanical sound (engine/brakes). If there are no clear spoken words, keep text empty. Do NOT invent smells or unrelated symptoms.",
          language: String(locale || "").split("-")[0] || undefined,
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = String(res?.text || "").trim();
    const speechEst = estimateSpeechFromWhisperVerbose(res);

    // Hard garbage guard
    if (text.length > 240) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // Forced mechanical sound: never use transcript
    if (isForcedMechanicalSound(audio_kind)) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // Clear non-speech from Whisper segments
    if (speechEst.hasSpeech === false) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // Likely speech
    if (speechEst.hasSpeech === true && text) {
      return { ok: true, text, audio_type: "speech", speech_score: speechEst.score };
    }

    // Ambiguous: only keep if short and wordy
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

  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  // OPTIONAL from Flutter: "voice" | "engine" | "brakes" | "car_sound"
  const audio_kind = normalizeAudioKind(body.audio_kind);

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
    let audioType = audioSmart.audio_type || "none";

    // Silicon Valley rule from you:
    // If user sends an audio file -> always prioritize mechanical sound analysis.
    // Do NOT assume road vibration unless user explicitly says so.
    // => Force non-speech if audio_kind is not "voice"
    if (audio_base_64 && audio_kind && audio_kind !== "voice") {
      voiceText = "";
      audioType = "non_speech";
    }

    // Prevent smell hallucination
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
      if (audioType === "speech" || audioType === "speech_maybe") audioType = "non_speech";
    }

    // Only mix transcript into fullInput if it is real speech
    const fullInput =
      `${text} ${(audioType === "speech" || audioType === "speech_maybe") ? voiceText : ""}`.trim();

    // ===== PLACES INTENT (typed text only + safe continuation) =====
    const typedPlaces = looksLikePlacesRequest(text);

    // Only continue places flow if the user asked recently AND current text is only location hint (ZIP / city, state)
    const priorPlacesRecent = lastUserAskedForPlacesRecently(history, 2);
    const locHintOnly = looksLikeLocationHintOnly(text);

    const placesIntent = typedPlaces || (priorPlacesRecent && locHintOnly);

    // ===== SEARCH =====
    // We still do KB search for diagnosis, but Places API is locked behind placesIntent ONLY.
    const searchPack = await withRetry(
      () =>
        withTimeout(
          performSearch(fullInput || text, user_location, {
            locale,
            allowPlaces: placesIntent, // 🔒 only when true
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
                priorPlacesRecent,
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

    // Mechanical-sound-first policy (your prompt) — injected into STRICT_CONTEXT
    const audioPolicy = `
AUDIO_POLICY:
- If AUDIO exists: treat it as MECHANICAL SOUND by default.
- Do NOT assume road vibration unless the USER explicitly says vibration/shake from road/tires.
- User's typed text is primary truth; do not override it with transcript guesses.
`.trim();

    const audioNote =
      audio_base_64
        ? (audioType === "speech" || audioType === "speech_maybe")
          ? `\nAUDIO_NOTE: USER_VOICE_PRESENT. Use transcript as supporting detail only.`
          : `\nAUDIO_NOTE: NON_SPEECH_MECHANICAL_SOUND (${audio_kind || "unspecified"}). Analyze it as engine/brake/mechanical noise.`
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Respond ONLY in LOCALE language.
- Use user's typed symptoms as primary truth.
- No filler. No invention. No generic theory.
- Ask at most ONE question only if it changes diagnosis.

${audioPolicy}

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
      ...(debugMode
        ? {
            debug: {
              stage: "ok",
              placesIntent,
              audioType,
              audio_kind,
              speech_score: audioSmart.speech_score,
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
