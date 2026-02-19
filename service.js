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

function looksLikeLocationHintOnly(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  if (/^\d{5}(-\d{4})?$/.test(t)) return true; // ZIP only
  if (/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t)) return true; // lat,lng

  const hints = [
    "i am in",
    "i'm in",
    "my location",
    "zip",
    "city",
    "state",
    "انا في",
    "أني في",
    "في ",
    "بال",
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
    else if (Array.isArray(c))
      text = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");

    text = String(text || "").trim();
    if (!text) continue;

    return looksLikePlacesRequest(text);
  }
  return false;
}

/* =========================================================
   AUDIO TRANSCRIPTION (SAFE FOR NON-SPEECH)
   - Use verbose_json + no_speech_prob
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

async function transcribeAudio(audioBase64) {
  if (!audioBase64 || String(audioBase64).length < 50)
    return { text: "", ok: false, meta: {} };

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          response_format: "verbose_json",
          temperature: 0,
          prompt:
            "This audio may contain NON-SPEECH automotive sounds. If there are no clear spoken words, return an empty transcript. Do NOT invent smells.",
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = String(result?.text || "").trim();

    // If verbose segments exist, use no_speech_prob to ignore engine-only audio
    const segs = Array.isArray(result?.segments) ? result.segments : [];
    if (segs.length > 0) {
      const avgNoSpeech =
        segs.reduce((a, s) => a + Number(s?.no_speech_prob || 0), 0) / segs.length;

      // mostly no speech -> ignore
      if (avgNoSpeech >= 0.6) return { text: "", ok: false, meta: { avgNoSpeech } };
    }

    if (!text) return { text: "", ok: false, meta: {} };

    // If transcript is huge, likely garbage
    if (text.length > 240) return { text: "", ok: false, meta: { dropped: "too_long" } };

    return { text, ok: true, meta: {} };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false, meta: { err: String(err?.message || err) } };
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

  // ✅ price meaning fields from updated search.js: price_meaning_ar / price_meaning_en
  const meaning = ar ? (w?.price_meaning_ar || "") : (w?.price_meaning_en || "");
  const price = w?.price_label
    ? ar
      ? `\nمستوى السعر: ${w.price_label}${meaning ? ` (${meaning})` : ""}`
      : `\nPrice level: ${w.price_label}${meaning ? ` (${meaning})` : ""}`
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

    // ===== AUDIO =====
    const audioResult = await transcribeAudio(audio_base_64);
    let voiceText = audioResult.ok ? audioResult.text : "";

    // 🔥 prevent "smell/burning" hallucination
    if (!containsSmellWords(text) && containsSmellWords(voiceText)) {
      voiceText = "";
    }

    // ✅ For diagnosis only, we can use fullInput
    const fullInput = `${text} ${voiceText}`.trim();

    // ===== PLACES INTENT (typed only + smart continuation) =====
    const typedPlaces = looksLikePlacesRequest(text);
    const priorPlaces = lastUserAskedForPlaces(history);
    const locHintOnly = looksLikeLocationHintOnly(text);
    const placesIntent = typedPlaces || (priorPlaces && locHintOnly);

    // ✅ CRITICAL: When doing places, use ONLY typed text (so voice never drifts query)
    const queryForSearch = placesIntent ? text : (fullInput || text);

    // ===== SEARCH (KB + Places when allowed) =====
    const searchPack = await withRetry(
      () =>
        withTimeout(
          performSearch(queryForSearch, user_location, {
            locale,
            allowPlaces: placesIntent,
            maxResults: 3,
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
      audio_base_64 && !voiceText
        ? "\nAUDIO_NOTE: Non-speech automotive sound. Do NOT infer smells. Diagnose sound patterns only and ask ONE short question: does it increase with RPM or vehicle speed?"
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Respond ONLY in LOCALE language.
- No filler.
- Rank likely causes + exact next checks.
- Ask at most ONE question only if it changes diagnosis.

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
AUDIO_TRANSCRIPT: ${voiceText || ""}${audioNote}

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
      ...(debugMode ? { debug: { stage: "ok" } } : {}),
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
