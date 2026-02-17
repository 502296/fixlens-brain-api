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
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  // Hebrew
  if (/[\u0590-\u05FF]/.test(t)) return "he";
  // Cyrillic (ru/uk/bg/etc)
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Devanagari
  if (/[\u0900-\u097F]/.test(t)) return "hi";
  // Thai
  if (/[\u0E00-\u0E7F]/.test(t)) return "th";
  // Korean
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(t)) return "ko";
  // Japanese
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Chinese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

  return "en"; // means "Latin-ish" here (could be fr/es/de/it/pt/etc)
}

function detectLocaleFromHistory(history) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;
    const c = msg?.content;

    if (typeof c === "string") {
      const lang = detectTextLanguage(c);
      if (lang) return lang;
    }

    if (Array.isArray(c)) {
      const joined = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
      const lang = detectTextLanguage(joined);
      if (lang) return lang;
    }
  }
  return "";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  // accept BCP-47 tags; never allow "auto"
  if (v.toLowerCase() === "auto") return "";
  return v;
}

function localeToLangTag(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

// If locale present -> trust it.
// Else infer from history -> else from text.
function inferLocale({ locale, text, history }) {
  const normalized = normalizeLocale(locale);
  if (normalized) return normalized;

  const fromHistory = detectLocaleFromHistory(history);
  if (fromHistory) return fromHistory;

  const fromText = detectTextLanguage(text || "");
  return fromText || "en";
}

// -----------------------------
// Better English heuristic
// -----------------------------
function isLikelyEnglish(s = "") {
  const t = String(s || "").toLowerCase();
  if (!t || t.length < 40) return false;

  const stop = [
    " the ",
    " and ",
    " you ",
    " your ",
    " with ",
    " for ",
    " that ",
    " this ",
    " from ",
    " are ",
    " is ",
    " to ",
    " of ",
    " in ",
    " on ",
    " it ",
    " as ",
    " can ",
    " please ",
    " try ",
    " will ",
  ];

  let score = 0;
  for (const w of stop) if (t.includes(w)) score++;
  return score >= 4;
}

// -----------------------------
// Script checks (for rewrite decisions)
// -----------------------------
function isMostlyArabic(s = "") {
  const t = String(s || "");
  const ar = (t.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return ar > 0 && ar >= latin * 0.6;
}

function isMostlyCyrillic(s = "") {
  const t = String(s || "");
  const cy = (t.match(/[\u0400-\u04FF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return cy > 0 && cy >= latin * 0.6;
}

function isMostlyCJK(s = "") {
  const t = String(s || "");
  const cjk = (t.match(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  return cjk > 0 && cjk >= latin * 0.4;
}

function isMostlyLatin(s = "") {
  const t = String(s || "");
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const nonlatin =
    (t.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return latin > 0 && latin >= nonlatin * 0.6;
}

// -----------------------------
// Fallback message (base -> then rewritten)
// -----------------------------
function fallbackMessageBase(locale) {
  const lang = localeToLangTag(locale);
  if (lang === "ar") {
    return "صار خلل بسيط. اكتب: (نوع السيارة + السنة + الأعراض + متى تظهر) وأنا أمشيك بخطة فحص دقيقة.";
  }
  return "A temporary issue occurred. Send: (car make/model + year + symptoms + when it happens) and I’ll give a precise check plan.";
}

function ensureNonEmptyReply(out, locale) {
  const text = String(out || "").trim();
  if (text) return text;
  return fallbackMessageBase(locale);
}

// -----------------------------
// Error debug
// -----------------------------
function getErrorDebug(err) {
  const d = {
    name: err?.name,
    message: err?.message,
    status: err?.status,
    code: err?.code,
    type: err?.type,
    param: err?.param,
  };
  if (err?.error) d.error = err.error;
  if (err?.response) d.response = err.response;
  if (err?.cause) d.cause = String(err.cause);
  return d;
}

// -----------------------------
// Language mismatch fixer (rewrite to locale) — GLOBAL
// -----------------------------
async function rewriteToLocale(text, locale) {
  const targetLocale = String(locale || "").trim() || "en";
  const targetLang = localeToLangTag(targetLocale);
  const original = String(text || "").trim();
  if (!original) return original;

  // If target is Arabic and already Arabic -> keep
  if (targetLang === "ar" && isMostlyArabic(original)) return original;

  // If target is English and likely English -> keep
  if (targetLang === "en" && isLikelyEnglish(original)) return original;

  // Strong rewrite rules:
  // 1) If target is non-latin and output is mostly latin -> rewrite
  const nonLatinTargets = new Set(["zh", "ja", "ko", "ru", "he", "hi", "th", "ar"]);
  if (nonLatinTargets.has(targetLang) && isMostlyLatin(original)) {
    // rewrite
  } else {
    // 2) If target is Latin language (fr/es/de/it/pt/nl/...) but output is clearly non-latin -> rewrite
    const latinTargets = new Set(["en", "fr", "es", "de", "it", "pt", "nl", "sv", "no", "da", "fi", "pl", "tr", "ro", "cs", "sk", "hu"]);
    if (latinTargets.has(targetLang)) {
      const nonLatinOut = isMostlyArabic(original) || isMostlyCyrillic(original) || isMostlyCJK(original);
      if (!nonLatinOut) {
        // 3) If target is not English and output looks English -> rewrite
        if (!(targetLang !== "en" && isLikelyEnglish(original))) {
          return original;
        }
      }
      // else rewrite
    } else {
      // 4) For any other target (unknown), if output looks English but target != en -> rewrite
      if (!(targetLang !== "en" && isLikelyEnglish(original))) {
        return original;
      }
    }
  }

  try {
    const r = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are a strict rewriter. Rewrite the given text in the target language only. Keep meaning and tone. Do not add new info. Do not add headings or lists.",
        },
        {
          role: "user",
          content: `TARGET_LOCALE: ${targetLocale}\nTARGET_LANGUAGE: ${targetLang}\n\nTEXT:\n${original}`,
        },
      ],
      temperature: 0,
    });

    const out = (r?.choices?.[0]?.message?.content || "").trim();
    return out || original;
  } catch (_) {
    return original;
  }
}

// -----------------------------
// Places intent detection (light)
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
    t.includes("auto repair") ||
    t.includes("garage") ||
    t.includes("repair shop") ||
    t.includes("address") ||
    t.includes("near me") ||
    t.includes("nearby") ||
    t.includes("google maps")
  )
    return true;

  // extra languages (light)
  if (t.includes("taller") || t.includes("mecanico") || t.includes("mécanicien") || t.includes("werkstatt")) return true;
  if (t.includes("автосервис") || t.includes("рядом")) return true;
  if (t.includes("附近") || t.includes("近く") || t.includes("근처")) return true;

  return false;
}

// NOTE: This base format is okay because we rewrite it later to locale.
// Keep it simple and structured for clarity.
function formatWorkshopsReplyBase(workshops = []) {
  const lines = workshops.slice(0, 5).map((w, i) => {
    const name = w?.name || "Workshop";
    const address = w?.address ? `\nAddress: ${w.address}` : "";
    const rating =
      w?.rating && Number(w.rating) > 0
        ? `\nRating: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} reviews)` : ""}`
        : "";
    const maps = w?.maps_url ? `\nGoogle Maps: ${w.maps_url}` : "";
    const phone = w?.phone ? `\nPhone: ${w.phone}` : "";
    return `${i + 1}) ${name}${address}${rating}${phone}${maps}`;
  });

  return (
    "Here are nearby mechanic shops based on your location:\n\n" +
    lines.join("\n\n") +
    "\n\nIf you tell me your neighborhood/area or the issue type (brakes/tires/transmission), I can refine the list."
  );
}

function formatNoWorkshopsReplyBase(locationHint = "") {
  const loc = String(locationHint || "").trim();
  const locLine = loc ? `\n(Location received: ${loc})` : "";

  return (
    "I can find nearby shops, but the search returned no results right now." +
    locLine +
    "\nThis usually happens if GPS is not available or Google Places isn’t responding." +
    "\nTry enabling GPS, or send your city + area/landmark (and country if needed) and try again."
  );
}

// -----------------------------
// Audio Transcription
// -----------------------------
async function transcribeAudio(audioBase64) {
  if (!audioBase64 || String(audioBase64).length < 50) return { text: "", ok: false };

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt:
        "Automotive diagnostic audio. Identify the type of sound and where it likely comes from: engine bay vs wheels/brakes. Include context cues: rpm-related vs speed-related. Short concise transcript.",
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

  // If client sends a BCP-47 locale, keep it.
  // Otherwise infer from history/text.
  let locale = inferLocale({ locale: body.locale, text, history });

  // ✅ worldwide: never default to a city
  const user_location = body.user_location || "Global";

  const effective_location =
    typeof user_location === "string" ? user_location : JSON.stringify(user_location);

  const image_base_64 = body.audio_base_64 ? (body.image_base_64 || body.image_base64 || "") : (body.image_base_64 || body.image_base64 || "");
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  const debugMode = Boolean(body.debug);

  try {
    // 1) audio transcript
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;

    // Full input used for search intent detection
    const fullInput = `${text} ${voiceText}`.trim();

    // ✅ Locale lock:
    // If body.locale exists, we keep it as authority.
    // If missing, we infer from input.
    const hasClientLocale = Boolean(normalizeLocale(body.locale));
    if (!hasClientLocale) {
      const langFromInput = detectTextLanguage(fullInput || text);
      if (langFromInput) locale = langFromInput;
    }

    // 2) Search (local KB + places)
    let VERIFIED_DATA = [];
    let VERIFIED_WORKSHOPS = [];

    try {
      const searchPack = await performSearch(fullInput || text, user_location, {
        locale,
        placesRadiusMeters: Number(body.places_radius_meters || 25000),
      });

      VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
      VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops) ? searchPack.verified_workshops : [];
    } catch (searchErr) {
      console.error("Search Error:", searchErr?.message || searchErr);
      VERIFIED_DATA = [];
      VERIFIED_WORKSHOPS = [];
    }

    // 3) If places request -> return deterministic list (then rewrite to locale)
    const isPlaces = looksLikePlacesRequest(fullInput || text);

    console.log("[FixLens][places_check]", {
      isPlaces,
      locale,
      user_location_type: typeof user_location,
      effective_location,
      workshops_count: Array.isArray(VERIFIED_WORKSHOPS) ? VERIFIED_WORKSHOPS.length : 0,
    });

    if (isPlaces) {
      const baseReply =
        VERIFIED_WORKSHOPS.length > 0
          ? formatWorkshopsReplyBase(VERIFIED_WORKSHOPS)
          : formatNoWorkshopsReplyBase(effective_location);

      // Provide a stronger Arabic base (if Arabic) before rewrite.
      const arBase =
        VERIFIED_WORKSHOPS.length > 0
          ? "هذه ورش/ميكانيك قريبة حسب موقعك:\n\n" +
            VERIFIED_WORKSHOPS.slice(0, 5)
              .map((w, i) => {
                const name = w?.name || "ورشة";
                const address = w?.address ? `\nالعنوان: ${w.address}` : "";
                const rating =
                  w?.rating && Number(w.rating) > 0
                    ? `\nالتقييم: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} مراجعة)` : ""}`
                    : "";
                const phone = w?.phone ? `\nالهاتف: ${w.phone}` : "";
                const maps = w?.maps_url ? `\nخرائط Google: ${w.maps_url}` : "";
                return `${i + 1}) ${name}${address}${rating}${phone}${maps}`;
              })
              .join("\n\n") +
            "\n\nإذا تكتب اسم المنطقة/الحي أو نوع المشكلة (فرامل/إطارات/قير) أرتّب لك قائمة أدق."
          : `وصلني موقعك: ${String(effective_location || "").trim() || "غير معروف"}.\nلكن البحث ما رجّع ورش الآن. هذا غالبًا بسبب أن GPS غير متاح أو Google Places غير شغّال/مقيّد.\nجرّب تفعيل GPS، أو اكتب (المدينة + المنطقة/معلم قريب + الدولة إذا لازم) وأعيد لك قائمة أدق.`;

      const reply = await rewriteToLocale(localeToLangTag(locale) === "ar" ? arBase : baseReply, locale);

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

    // 4) Build message content for model (STRICT_CONTEXT)
    const messageContent = [];

    const audioBlock =
      audio_base_64 && !audioResult.ok
        ? "\nAUDIO_NOTE: No clear transcript. Ask ONE short follow-up to resend 10–15s close to the source. Do not guess from audio."
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

LANGUAGE_RULES:
- Respond ONLY in the language implied by LOCALE.
- No bilingual output unless the user explicitly asks.
- Worldwide: never assume country/city/fuel/regulations/units unless provided.

SEARCH_RULES:
- Use VERIFIED_DATA_JSON only if relevant.
- Use VERIFIED_WORKSHOPS_JSON when the user asks for places.

AUDIO_TRANSCRIPT_OK: ${audioResult.ok ? "YES" : audio_base_64 ? "NO" : "NO_AUDIO"}
AUDIO_TRANSCRIPT: ${voiceText || ""}${audioBlock}

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
        text: "Use the photo to identify visible parts, leaks, wear, cracks, residue, alignment. Tie findings to ONE most probable diagnosis.",
      });
    }

    // 5) Model response
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

    // ✅ enforce locale output for ALL languages
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

    let safeReply = fallbackMessageBase(locale);
    safeReply = await rewriteToLocale(safeReply, locale);

    return {
      ok: false,
      reply: safeReply,
      locale,
      workshops_count: 0,
      ...(debugMode ? { debug: { stage: "catch", ...dbg } } : {}),
    };
  }
}
