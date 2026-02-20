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
   LANGUAGE (stable + override wrong locale from client)
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

// If Flutter sends locale incorrectly (e.g., "en"), we override using script detection
function inferLocale({ locale, text }) {
  const normalized = normalizeLocale(locale);
  const detected = detectTextLanguage(text || "");

  // If no locale from client, use detected
  if (!normalized) return detected || "en";

  const short = normalized.split("-")[0].toLowerCase();
  // If user text is clearly Arabic/Japanese/etc but client claims "en", override.
  if (text && text.trim().length >= 2 && detected && detected !== short) {
    // Only override when detected is strong non-English
    if (["ar", "ja", "zh", "ko", "ru"].includes(detected)) return detected;
  }

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
    "workshop",
    "tire shop",
    "tyre shop",
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
    "وين الورشة",
    "اقرب ورشة",
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
    "انا حاليا في",
    "موقعي",
    "zip",
    "المنطقة",
    "الحي",
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
   AUDIO: prioritize MECHANICAL SOUND unless user says road vibration
========================================================= */
function userExplicitlySaysRoadVibration(s = "") {
  const t = String(s || "").toLowerCase();
  const roadWords = [
    "road vibration",
    "vibration from road",
    "tire vibration",
    "tyre vibration",
    "wheel vibration",
    "steering wheel shake",
    "alignment",
    "balance",
    "اهتزاز طريق",
    "اهتزاز من الطريق",
    "رجفة من الاطارات",
    "رجفة من الإطارات",
    "رجفة بالدركسون",
    "ميزان",
    "ترصيص",
    "وزن اطارات",
    "وزن إطارات",
  ];
  return roadWords.some((w) => t.includes(w));
}

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

async function transcribeAudioSmart(audioBase64, locale, { audioKind = "", forceMechanical = true } = {}) {
  if (!audioBase64 || String(audioBase64).length < 50) {
    return { ok: false, text: "", audio_type: "none", speech_score: 0 };
  }

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const lang = String(locale || "").split("-")[0] || undefined;

    const res = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          response_format: "verbose_json",
          prompt:
            "Audio may be NON-SPEECH automotive mechanical sounds (engine/brakes). If no clear spoken words, keep text extremely short or empty. Do not invent smells or context.",
          language: lang,
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = String(res?.text || "").trim();
    const speechEst = estimateSpeechFromWhisperVerbose(res);

    // If we force mechanical, we NEVER let transcript override the request.
    // (We still run whisper to detect if user spoke words, but we won't mix it unless clearly speech.)
    const forcedMechanical =
      forceMechanical ||
      ["engine", "brakes", "car_sound", "sound", "noise", "mechanical"].includes(
        String(audioKind || "").toLowerCase()
      );

    // Hard rules:
    if (text.length > 240) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }
    if (speechEst.hasSpeech === false) {
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // If forced mechanical: keep transcript only if it's clearly short speech (e.g., user said "cold start")
    if (forcedMechanical) {
      const looksWordy = /[a-zA-Z\u0600-\u06FF]{3,}/.test(text);
      if (speechEst.hasSpeech === true && text && text.length <= 80 && looksWordy) {
        return { ok: true, text, audio_type: "speech_maybe", speech_score: speechEst.score };
      }
      return { ok: true, text: "", audio_type: "non_speech", speech_score: speechEst.score };
    }

    // Not forced mechanical (rare): normal speech handling
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

  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  // OPTIONAL from Flutter: "engine" | "brakes" | "voice" | "car_sound"
  // If user sends audio and Flutter doesn't specify -> default to mechanical "car_sound"
  let audio_kind = String(body.audio_kind || "").trim();
  if (audio_base_64 && !audio_kind) audio_kind = "car_sound";

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
    // Rule: If audio exists -> prioritize it as MECHANICAL SOUND unless user explicitly says road vibration
    const forceMechanical = audio_base_64 ? !userExplicitlySaysRoadVibration(text) : false;

    const audioSmart = await transcribeAudioSmart(audio_base_64, locale, {
      audioKind: audio_kind,
      forceMechanical,
    });

    let voiceText = audioSmart.ok ? String(audioSmart.text || "").trim() : "";
    const audioType = audioSmart.audio_type || "none";

    // Prevent smell hallucination
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // IMPORTANT: if audio is NON-SPEECH we do NOT mix transcript into the main text
    const fullInput = `${text} ${audioType === "speech" || audioType === "speech_maybe" ? voiceText : ""}`.trim();

    // ===== PLACES INTENT (typed text only + smart continuation) =====
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

    const audioPolicyLine = forceMechanical
      ? "If audio is present, prioritize it as MECHANICAL SOUND. Do NOT assume road/tire vibration unless the user explicitly says road/wheel/tire vibration."
      : "User explicitly mentioned road/wheel/tire vibration — you may consider that context.";

    const audioNote =
      audio_base_64
        ? `\nAUDIO_POLICY: ${audioPolicyLine}\nAUDIO_NOTE: ${audioType === "non_speech" || !voiceText ? "NON_SPEECH_MECHANICAL_SOUND" : "POSSIBLE_SPOKEN_WORDS"} (${audio_kind || "unspecified"}). Do NOT invent smells.`
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Respond ONLY in LOCALE language.
- Use user's typed symptoms as primary truth.
- If audio exists: treat it as mechanical sound by default. Never assume road vibration unless user explicitly says so.
- No filler. No invention. No generic menus.
- Pick ONE most likely cause. Mention ONE secondary only if a single quick check separates them.
- Ask at most ONE question only if it changes the diagnosis.

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

    // Reduce language contamination from old assistant history (keeps user context)
    const sanitizedHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === "user" || m.role === "assistant"))
          .slice(-6)
      : [];

    const response = await withRetry(
      () =>
        withTimeout(
          client.chat.completions.create({
            model: process.env.FIXLENS_MODEL || "gpt-4o",
            messages: [
              { role: "system", content: buildDoctorSystemPrompt() },
              ...sanitizedHistory,
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
      ...(debugMode ? { debug: { stage: "ok", audioType, speech_score: audioSmart.speech_score, forceMechanical } } : {}),
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
