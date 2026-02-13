// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -----------------------------
// Helpers: Language / Locale
// -----------------------------

function detectTextLanguage(text = "") {
  const t = String(text || "");

  // Arabic
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  // Hebrew
  if (/[\u0590-\u05FF]/.test(t)) return "he";
  // Cyrillic (ru/uk/bg etc.)
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Devanagari (hi)
  if (/[\u0900-\u097F]/.test(t)) return "hi";
  // Thai
  if (/[\u0E00-\u0E7F]/.test(t)) return "th";
  // Korean
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(t)) return "ko";
  // Japanese
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Chinese (CJK Unified)
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

  // Latin-based languages: default to en unless user sends locale
  return "en";
}

function detectLocaleFromHistory(history) {
  if (!Array.isArray(history)) return "";

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;

    const c = msg?.content;

    // plain string
    if (typeof c === "string") {
      const lang = detectTextLanguage(c);
      if (lang) return lang;
    }

    // multimodal array
    if (Array.isArray(c)) {
      const joined = c
        .map((x) => (typeof x?.text === "string" ? x.text : ""))
        .join(" ");
      const lang = detectTextLanguage(joined);
      if (lang) return lang;
    }
  }

  return "";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  // Accept BCP-47 like ar, ar-IQ, en-US, etc.
  return v;
}

function inferLocale({ locale, text, history }) {
  const normalized = normalizeLocale(locale);
  if (normalized) return normalized;

  const fromHistory = detectLocaleFromHistory(history);
  if (fromHistory) return fromHistory;

  const fromText = detectTextLanguage(text || "");
  return fromText || "en";
}

function localeToLangTag(locale) {
  // Reduce "ar-IQ" -> "ar" when needed
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

function fallbackMessage(locale) {
  const lang = localeToLangTag(locale);

  if (lang === "ar") {
    return "حصلت مشكلة مؤقتة أثناء التحليل أو البحث، لكن أقدر أساعدك بالتشخيص الآن. اكتب: (نوع السيارة + السنة + الأعراض + متى تظهر المشكلة) وسأعطيك خطة فحص دقيقة.";
  }

  return "A temporary issue occurred during analysis or search, but I can still help you right now. Please send: (car make/model + year + symptoms + when it happens) and I’ll give you a precise check plan.";
}

function ensureNonEmptyReply(out, locale) {
  const text = String(out || "").trim();
  if (text) return text;
  return fallbackMessage(locale);
}

// -----------------------------
// Debug helpers (NEW)
// -----------------------------
function getErrorDebug(err) {
  // OpenAI SDK v4 errors may include status/code/type/param
  const d = {
    name: err?.name,
    message: err?.message,
    status: err?.status,
    code: err?.code,
    type: err?.type,
    param: err?.param,
  };

  // Sometimes more details exist:
  if (err?.error) d.error = err.error;
  if (err?.response) d.response = err.response;
  if (err?.cause) d.cause = String(err.cause);

  return d;
}

// -----------------------------
// NEW: Language lock + mismatch fixer
// -----------------------------
function isMostlyArabic(s = "") {
  const t = String(s || "");
  const ar = (t.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return ar > 0 && ar >= latin * 0.6;
}

function isMostlyLatin(s = "") {
  const t = String(s || "");
  const ar = (t.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return latin > 0 && latin >= ar * 0.6;
}

async function rewriteToLocale(text, locale) {
  const lang = localeToLangTag(locale);

  // If already matches, return as-is
  if (lang === "ar" && isMostlyArabic(text)) return text;
  if (lang !== "ar" && isMostlyLatin(text)) return text;

  // Do a tight rewrite/translation (no extra info)
  try {
    const r = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a strict rewriter. Rewrite the given text in the target language only. Keep meaning, keep structure, do not add new info.",
        },
        {
          role: "user",
          content: `TARGET_LOCALE: ${locale}\nTARGET_LANGUAGE: ${lang}\n\nTEXT:\n${String(
            text || ""
          ).trim()}`,
        },
      ],
      temperature: 0,
    });

    const out = (r?.choices?.[0]?.message?.content || "").trim();
    return out || text;
  } catch (_) {
    return text;
  }
}

// -----------------------------
// NEW: Places intent detection + deterministic replies
// -----------------------------
function looksLikePlacesRequest(fullInput = "") {
  const t = String(fullInput || "").toLowerCase();

  // Arabic
  if (
    t.includes("ورشة") ||
    t.includes("ورش") ||
    t.includes("ميكاني") ||
    t.includes("ميكانيكي") ||
    t.includes("كراج") ||
    t.includes("عنوان") ||
    t.includes("اقرب") ||
    t.includes("قريبة") ||
    t.includes("موقع") ||
    t.includes("خرائط")
  )
    return true;

  // English
  if (
    t.includes("mechanic") ||
    t.includes("shop") ||
    t.includes("auto repair") ||
    t.includes("garage") ||
    t.includes("address") ||
    t.includes("near me") ||
    t.includes("nearby") ||
    t.includes("in louisville") ||
    t.includes("kentucky")
  )
    return true;

  return false;
}

function formatWorkshopsReply(locale, workshops = []) {
  const lang = localeToLangTag(locale);

  if (lang === "ar") {
    const lines = workshops.slice(0, 5).map((w, i) => {
      const name = w?.name || "ورشة";
      const address = w?.address ? `\nالعنوان: ${w.address}` : "";
      const rating =
        w?.rating && Number(w.rating) > 0
          ? `\nالتقييم: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} مراجعة)` : ""}`
          : "";
      const maps = w?.maps_url ? `\nخرائط Google: ${w.maps_url}` : "";
      return `${i + 1}) ${name}${address}${rating}${maps}`;
    });

    return (
      "هذه أفضل ورش/ميكانيك قريبة حسب موقعك الحالي:\n\n" +
      lines.join("\n\n") +
      "\n\nإذا تحب، اكتب اسم الحي/المنطقة أو نوع المشكلة (فرامل/إطارات/قير) وأرتّب لك قائمة أدق."
    );
  }

  // default English
  const lines = workshops.slice(0, 5).map((w, i) => {
    const name = w?.name || "Workshop";
    const address = w?.address ? `\nAddress: ${w.address}` : "";
    const rating =
      w?.rating && Number(w.rating) > 0
        ? `\nRating: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} reviews)` : ""}`
        : "";
    const maps = w?.maps_url ? `\nGoogle Maps: ${w.maps_url}` : "";
    return `${i + 1}) ${name}${address}${rating}${maps}`;
  });

  return (
    "Here are good nearby mechanic shops based on your current location:\n\n" +
    lines.join("\n\n") +
    "\n\nIf you tell me your neighborhood or the issue type (brakes/tires/transmission), I can refine the list."
  );
}

function formatNoWorkshopsReply(locale) {
  const lang = localeToLangTag(locale);

  if (lang === "ar") {
    return (
      "أقدر أطلع لك ورش قريبة، لكن ما قدرت أحدد موقعك بشكل كافي الآن.\n" +
      "اكتب اسم المدينة/الحي (مثلاً: Louisville, KY أو اسم منطقتك)، أو فعّل GPS داخل التطبيق ثم جرّب مرة ثانية."
    );
  }

  return (
    "I can find nearby shops, but I can’t determine your location precisely right now.\n" +
    "Send your city/neighborhood (e.g., Louisville, KY), or enable GPS in the app and try again."
  );
}

// -----------------------------
// Audio Transcription
// -----------------------------
async function transcribeAudio(audioBase64) {
  if (!audioBase64 || String(audioBase64).length < 50) return { text: "", ok: false };

  // NOTE: currently assumes m4a
  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt:
        "Automotive diagnostic audio. Focus on noises: knock, ping, squeal, grind, tick, rattle, hiss, bearing, belt, misfire.",
    });

    const text = (result?.text || "").trim();
    return { text, ok: Boolean(text) };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// -----------------------------
// Main Handler
// -----------------------------
export async function handleFixLensRequest(req) {
  const body = req.body || {};

  const text = body.text || "";
  const history = Array.isArray(body.history) ? body.history : [];

  // Locale: allow explicit locale from app (recommended), otherwise infer from history/text
  let locale = inferLocale({ locale: body.locale, text, history });

  // ✅ GLOBAL: never default to Louisville. Use what app sends or "Global"
  const user_location = body.user_location || "Global";

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  // ✅ Debug mode (optional): send debug:true from app when testing
  const debugMode = Boolean(body.debug);

  try {
    // 1) transcribe audio (if any)
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;
    const fullInput = `${text} ${voiceText}`.trim();

    // ✅ HARD OVERRIDE: if user clearly typed Arabic, lock locale to Arabic (even if device locale is en-US)
    const langFromInput = detectTextLanguage(fullInput || text);
    if (langFromInput === "ar") {
      // keep region tag if already ar-XX, else set to "ar"
      const base = localeToLangTag(locale);
      locale = base === "ar" ? locale : "ar";
    }

    // 2) Local verified search from /data + optional Google Places
    let VERIFIED_DATA = [];
    let VERIFIED_WORKSHOPS = [];

    try {
      const searchPack = await performSearch(fullInput || text, user_location, {
        locale,
        placesRadiusMeters: Number(body.places_radius_meters || 25000),
      });

      VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
      VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops)
        ? searchPack.verified_workshops
        : [];
    } catch (searchErr) {
      console.error("Search Error:", searchErr?.message || searchErr);
      VERIFIED_DATA = [];
      VERIFIED_WORKSHOPS = [];
    }

    // ✅ NEW: If user asked for workshops/places, return deterministic output
    const isPlaces = looksLikePlacesRequest(fullInput || text);

    if (isPlaces) {
      const reply =
        VERIFIED_WORKSHOPS.length > 0
          ? formatWorkshopsReply(locale, VERIFIED_WORKSHOPS)
          : formatNoWorkshopsReply(locale);

      return {
        ok: true,
        reply,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places_short_circuit",
                model: process.env.FIXLENS_MODEL || "gpt-4o",
                has_workshops: VERIFIED_WORKSHOPS.length > 0,
                user_location_type: typeof user_location,
              },
            }
          : {}),
      };
    }

    // 3) Build user message content
    const messageContent = [];

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

LANGUAGE_RULES:
- Respond ONLY in the user's language implied by LOCALE (no bilingual output unless the user explicitly requests bilingual).
- If LOCALE is a region tag (e.g., ar-IQ), use that language naturally.
- Never assume a fixed city/country. Use LOCATION only if provided; otherwise treat it as Global.

WORKSHOP_RULE:
- If user asks for workshops/places, use VERIFIED_WORKSHOPS_JSON first.
- If VERIFIED_WORKSHOPS_JSON is empty, ask for city/neighborhood OR ask permission to use GPS, then provide a safe selection checklist (still in same language).

AUDIO_TRANSCRIPT_OK: ${audioResult.ok ? "YES" : audio_base_64 ? "NO" : "NO_AUDIO"}
AUDIO_TRANSCRIPT: ${voiceText || ""}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

USER_INPUT: ${(text || "").trim()}`,
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text:
          "Use the photo to identify visible parts, damage, leaks, wear, or incorrect installation. Tie findings to diagnosis.",
      });
    }

    // 4) Model response
    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        ...history.slice(-8),
        { role: "user", content: messageContent },
      ],
      temperature: 0.2,
    });

    const outRaw = response?.choices?.[0]?.message?.content || "";
    let out = ensureNonEmptyReply(outRaw, locale);

    // ✅ NEW: if model answered in wrong language, rewrite to match locale
    out = await rewriteToLocale(out, locale);

    return {
      ok: true,
      reply: out,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      ...(debugMode ? { debug: { stage: "ok", model: process.env.FIXLENS_MODEL || "gpt-4o" } } : {}),
    };
  } catch (error) {
    const dbg = getErrorDebug(error);
    console.error("FixLens Error:", dbg);

    const safeReply = fallbackMessage(locale);

    return {
      ok: false,
      reply: safeReply,
      locale,
      workshops_count: 0,
      ...(debugMode ? { debug: { stage: "catch", ...dbg } } : {}),
    };
  }
}
