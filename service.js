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

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0590-\u05FF]/.test(t)) return "he"; // Hebrew
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Cyrillic
  if (/[\u0900-\u097F]/.test(t)) return "hi"; // Devanagari
  if (/[\u0E00-\u0E7F]/.test(t)) return "th"; // Thai
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(t)) return "ko"; // Korean
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // Japanese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // Chinese

  return "en";
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
  return v; // accept BCP-47 tags
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
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
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
// Fallback message (base -> then rewritten)
// -----------------------------
function fallbackMessageBase(locale) {
  const lang = localeToLangTag(locale);
  if (lang === "ar") {
    return "صار خلل بسيط أثناء التحليل/البحث. اكتب: (نوع السيارة + السنة + الأعراض + متى تظهر) وأنا أمشيك بخطة فحص دقيقة.";
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
// Language mismatch fixer (rewrite to locale)
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
  const original = String(text || "").trim();
  if (!original) return original;

  if (lang === "ar" && isMostlyArabic(original)) return original;
  if (lang === "en" && isLikelyEnglish(original)) return original;

  const nonLatinTargets = new Set(["zh", "ja", "ko", "ru", "he", "hi", "th", "ar"]);
  const needsRewrite =
    (lang !== "en" && isLikelyEnglish(original)) ||
    (nonLatinTargets.has(lang) && isMostlyLatin(original));

  if (!needsRewrite) return original;

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
          content: `TARGET_LOCALE: ${locale}\nTARGET_LANGUAGE: ${lang}\n\nTEXT:\n${original}`,
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

  // few extra languages
  if (t.includes("taller") || t.includes("mecanico") || t.includes("mécanicien") || t.includes("werkstatt")) return true;
  if (t.includes("автосервис") || t.includes("рядом")) return true;
  if (t.includes("附近") || t.includes("近く") || t.includes("근처")) return true;

  return false;
}

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
    "Here are good nearby mechanic shops based on your location:\n\n" +
    lines.join("\n\n") +
    "\n\nIf you tell me your neighborhood or the issue type (brakes/tires/transmission), I can refine the list."
  );
}

// ✅ UPDATED: better no-results message (don’t keep telling user “send city” if they already did)
function formatNoWorkshopsReplyBase(locationHint = "") {
  const loc = String(locationHint || "").trim();
  const locLine = loc ? `\n(Location received: ${loc})` : "";

  return (
    "I can find nearby shops, but the search returned no results right now." +
    locLine +
    "\nThis usually happens if GPS is not available or Google Places isn’t responding." +
    "\nTry enabling GPS, or send your ZIP code / neighborhood and try again."
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

  let locale = inferLocale({ locale: body.locale, text, history });

  // ✅ worldwide: never default to a city
  const user_location = body.user_location || "Global";

  // ✅ A safe printable location hint for logs/messages
  const effective_location =
    typeof user_location === "string" ? user_location : JSON.stringify(user_location);

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  const debugMode = Boolean(body.debug);

  try {
    // 1) audio transcript
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;

    // Full input used for search intent detection and locale lock
    const fullInput = `${text} ${voiceText}`.trim();

    // ✅ Strong locale lock: match last user sentence language
    const langFromInput = detectTextLanguage(fullInput || text);
    if (langFromInput) {
      // keep region if already same base, else switch base-only
      const base = localeToLangTag(locale);
      if (langFromInput !== base) locale = langFromInput;
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

    // ✅ LOGS to Render (always visible)
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

      // If Arabic target, provide an Arabic-flavored base first (better than machine translating English list)
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
            "\n\nإذا تكتب اسم الحي أو نوع المشكلة (فرامل/إطارات/قير) أرتّب لك قائمة أدق."
          : `وصلني موقعك: ${String(effective_location || "").trim() || "غير معروف"}.\nلكن البحث ما رجّع ورش الآن. هذا غالبًا بسبب أن GPS غير متاح أو Google Places غير شغّال/مقيّد.\nجرّب تفعيل GPS، أو اكتب ZIP/اسم الحي (مثلاً: 40202) وأعيد لك قائمة أدق.`;

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
        ? "\nAUDIO_NOTE: The provided audio did not yield a clear transcript. Do NOT guess from audio. Ask ONE short follow-up to resend 10-15s near the source."
        : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

LANGUAGE_RULES:
- Respond ONLY in the user's language implied by LOCALE.
- No bilingual output unless user explicitly requests it.
- Worldwide: never assume country/city/fuel/regulations unless provided.

SEARCH_RULES:
- VERIFIED_DATA_JSON may contain known verified patterns. Use it only if relevant.
- If the user asks for workshops/places, rely on VERIFIED_WORKSHOPS_JSON first.

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
        text: "Use the photo to identify visible parts, leaks, wear, cracks, residue, alignment. Tie findings to the single most probable diagnosis.",
      });
    }

    // 5) Model response
    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [{ role: "system", content: buildDoctorSystemPrompt() }, ...history.slice(-8), { role: "user", content: messageContent }],
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
