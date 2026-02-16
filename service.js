// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const FIXLENS_STYLE_INJECTOR = `
You are FixLens — a real professional automotive diagnostic expert.

You are NOT an assistant, NOT a chatbot, and NOT a teacher.
You are a calm, experienced mechanic speaking directly to a driver who needs help right now.

MISSION:
Make a fast, confident, most-probable diagnosis, guide the driver safely, and create trust.

CORE RULES:
- Start naturally. Do not repeat the same opening every time.
- Give ONE primary diagnosis only.
- Explain the cause in one short human sentence.
- Predict what will happen if ignored.
- Provide ONE simple immediate test the driver can do now.
- Always clearly state if the vehicle can still be driven and under what limits.
- If unsafe → clearly say stop driving.
- Do NOT use bullet points or numbered lists.
- Write short natural paragraphs only.
- Avoid robotic disclaimers or legal style.
- NEVER say: "as an AI", "I might be wrong", "consult a professional".

LANGUAGE:
- Always reply in the SAME language the user used.
- If mixed languages → use the language of the last sentence.
- FixLens is worldwide. Never assume country/region unless user provides it.
`.trim();

// -----------------------------
// Helpers: Language / Locale
// -----------------------------

function detectTextLanguage(text = "") {
  const t = String(text || "");

  // Non-Latin scripts (high confidence)
  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0590-\u05FF]/.test(t)) return "he"; // Hebrew
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Cyrillic
  if (/[\u0900-\u097F]/.test(t)) return "hi"; // Devanagari
  if (/[\u0E00-\u0E7F]/.test(t)) return "th"; // Thai
  if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(t)) return "ko"; // Korean
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // Japanese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // Chinese

  // Latin-based quick heuristics (best effort)
  const s = t.toLowerCase();

  const has = (arr) => arr.some((w) => s.includes(w));
  const longEnough = s.length >= 30;

  if (longEnough && has(["¿", "¡", " que ", " para ", " con ", " cerca ", " taller ", " mecánico", " mecanico"])) return "es";
  if (longEnough && has([" le ", " la ", " les ", " pour ", " avec ", " près ", " garage ", " mécanicien", " mecanicien"])) return "fr";
  if (longEnough && has([" der ", " die ", " das ", " und ", " für ", " mit ", " werkstatt ", " in der nähe", " in der nahe"])) return "de";
  if (longEnough && has([" il ", " lo ", " la ", " per ", " con ", " vicino ", " officina ", " meccanico"])) return "it";
  if (longEnough && has([" não ", " nao ", " para ", " com ", " perto ", " oficina ", " mecânico", " mecanico"])) return "pt";

  return "en";
}

function lastUserTextFromHistory(history) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;
    const c = msg?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const joined = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
      if (joined.trim()) return joined;
    }
  }
  return "";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v) return "";
  // Accept BCP-47 like ar, ar-IQ, en-US, fr-FR...
  return v;
}

function inferLocale({ locale, text, history }) {
  const normalized = normalizeLocale(locale);
  if (normalized) return normalized;

  // strongest: last user message
  const lastUser = lastUserTextFromHistory(history);
  const fromLast = detectTextLanguage(lastUser);
  if (fromLast) return fromLast;

  // then from current text
  const fromText = detectTextLanguage(text || "");
  return fromText || "en";
}

function localeToLangTag(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

// -----------------------------
// Reply language checks
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

function looksLikeEnglish(s = "") {
  const t = String(s || "").toLowerCase();
  if (!t || t.length < 40) return false;
  const stop = [" the ", " and ", " you ", " your ", " with ", " for ", " that ", " this ", " from ", " are ", " is ", " to ", " of ", " in ", " on "];
  let score = 0;
  for (const w of stop) if (t.includes(w)) score++;
  return score >= 4;
}

async function rewriteToLocale(text, locale) {
  const lang = localeToLangTag(locale);
  const original = String(text || "").trim();
  if (!original) return original;

  // obvious matches
  if (lang === "ar" && isMostlyArabic(original)) return original;
  if (lang === "en" && looksLikeEnglish(original)) return original;

  // if target is non-latin script and output is mostly Latin -> rewrite
  const nonLatinTargets = new Set(["zh", "ja", "ko", "ru", "he", "hi", "th", "ar"]);
  if (nonLatinTargets.has(lang) && isMostlyLatin(original)) {
    // rewrite
  } else if (lang !== "en" && looksLikeEnglish(original)) {
    // rewrite
  } else {
    // don't over-force
    return original;
  }

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

function fallbackMessageBase(locale) {
  const lang = localeToLangTag(locale);
  if (lang === "ar") {
    return "صار خلل بسيط أثناء التحليل/البحث. جرّب مرة ثانية بعد لحظة. اكتب: (نوع السيارة + السنة + الأعراض + متى تظهر المشكلة) وسأعطيك خطة فحص دقيقة.";
  }
  return "A temporary issue occurred during analysis/search. Please try again in a moment. Send: (car make/model + year + symptoms + when it happens) and I’ll give a precise check plan.";
}

function ensureNonEmptyReply(out, locale) {
  const text = String(out || "").trim();
  if (text) return text;
  return fallbackMessageBase(locale);
}

// -----------------------------
// Debug helper
// -----------------------------
function getErrorDebug(err) {
  return {
    name: err?.name,
    message: err?.message,
    status: err?.status,
    code: err?.code,
    type: err?.type,
    param: err?.param,
    error: err?.error,
    response: err?.response,
    cause: err?.cause ? String(err.cause) : undefined,
  };
}

// -----------------------------
// Places intent (more robust, global)
// -----------------------------
function looksLikePlacesRequest(fullInput = "") {
  const t = String(fullInput || "").toLowerCase().trim();
  if (!t) return false;

  const keywords = [
    // Arabic
    "ورشة", "ورش", "ميكاني", "ميكانيكي", "كراج", "عنوان", "اقرب", "قريبة", "قريب مني", "موقع", "خرائط",
    "محل", "محلات", "اطارات", "إطارات", "كفر", "كفرات", "تواير", "بنشر", "بنچر",

    // English
    "mechanic", "garage", "auto repair", "repair shop", "tire shop", "tyre shop", "brake shop",
    "near me", "nearby", "address", "google maps",

    // Spanish / Portuguese
    "taller", "mecánico", "mecanico", "cerca", "cerca de mi", "cerca de mí", "oficina", "mecânico", "mecanico", "perto de mim",

    // French
    "mécanicien", "mecanicien", "près", "pres de moi", "adresse", "garage",

    // German
    "werkstatt", "mechaniker", "in der nähe", "in der nahe", "adresse",

    // Russian
    "автосервис", "мастерская", "рядом", "адрес",

    // Chinese/Japanese/Korean
    "附近", "修理", "维修", "近く", "整備", "근처", "정비", "수리",
  ];

  return keywords.some((w) => t.includes(w));
}

// -----------------------------
// Audio: detect container (m4a/wav/webm/mp3/ogg)
// -----------------------------
function sniffAudioExtFromBase64(b64 = "") {
  try {
    const buf = Buffer.from(String(b64), "base64");
    if (!buf || buf.length < 16) return "m4a";

    // RIFF....WAVE
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE") return "wav";
    // OggS
    if (buf.slice(0, 4).toString("ascii") === "OggS") return "ogg";
    // ID3 (mp3) or FF FB
    if (buf.slice(0, 3).toString("ascii") === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return "mp3";
    // EBML (webm/mkv) 1A 45 DF A3
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
    // MP4/M4A: ....ftyp
    if (buf.slice(4, 8).toString("ascii") === "ftyp") return "m4a";

    return "m4a";
  } catch (_) {
    return "m4a";
  }
}

async function transcribeAudio(audioBase64, locale) {
  if (!audioBase64 || String(audioBase64).length < 50) return { text: "", ok: false };

  const ext = sniffAudioExtFromBase64(audioBase64);
  const tempPath = path.join("/tmp", `v_${Date.now()}.${ext}`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      // Prompt stays automotive; locale helps a bit
      prompt:
        localeToLangTag(locale) === "ar"
          ? "صوت متعلق بتشخيص سيارة. ركّز على الأصوات: طقطقة، صرير، حِكّة، خبط، رجة، صفير، رجة عجلات، رمان، سير."
          : "Automotive diagnostic audio. Focus on noises: knock, ping, squeal, grind, tick, rattle, hiss, bearing, belt, misfire.",
    });

    const text = (result?.text || "").trim();
    return { text, ok: Boolean(text) };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
}

// -----------------------------
// Simple timeout guard (fix: “first message no reply” when request hangs)
// -----------------------------
async function withTimeout(promise, ms, onTimeoutValue) {
  let t;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve(onTimeoutValue), ms);
  });
  const res = await Promise.race([promise, timeout]);
  clearTimeout(t);
  return res;
}

// -----------------------------
// Main Handler
// -----------------------------
export async function handleFixLensRequest(req) {
  const body = req.body || {};

  const text = body.text || "";
  const history = Array.isArray(body.history) ? body.history : [];

  // Locale: prefer explicit locale from app, else infer from last user sentence/text
  let locale = inferLocale({ locale: body.locale, text, history });

  // GLOBAL: never assume a city
  const user_location = body.user_location || "Global";

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  const debugMode = Boolean(body.debug);

  try {
    // 1) transcribe audio
    const audioResult = await transcribeAudio(audio_base_64, locale);
    const voiceText = audioResult.text;

    // Decide language from the LAST user sentence (strongest)
    const lastUser = lastUserTextFromHistory(history);
    const langFromLast = detectTextLanguage(lastUser);
    const langFromNow = detectTextLanguage(text);
    const effectiveLang = langFromNow || langFromLast || localeToLangTag(locale) || "en";
    if (effectiveLang) {
      // keep region if already same base
      const base = localeToLangTag(locale);
      locale = base === effectiveLang ? locale : effectiveLang;
    }

    const fullInput = `${text} ${voiceText}`.trim();

    // 2) search
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

    // 3) If user asked for shops/places, reply deterministically (and in same language)
    const isPlaces = looksLikePlacesRequest(fullInput || text);

    if (isPlaces) {
      let baseReply = "";

      if (VERIFIED_WORKSHOPS.length > 0) {
        // keep it readable and guaranteed address/maps
        baseReply =
          "Here are good nearby mechanic shops based on your current location:\n\n" +
          VERIFIED_WORKSHOPS.slice(0, 5)
            .map((w, i) => {
              const name = w?.name || "Workshop";
              const address = w?.address ? `\nAddress: ${w.address}` : "";
              const rating =
                w?.rating && Number(w.rating) > 0
                  ? `\nRating: ${w.rating}${w?.ratings_count ? ` (${w.ratings_count})` : w?.ratings_total ? ` (${w.ratings_total})` : ""}`
                  : "";
              const maps = w?.maps_url ? `\nGoogle Maps: ${w.maps_url}` : "";
              return `${i + 1}) ${name}${address}${rating}${maps}`;
            })
            .join("\n\n") +
          "\n\nTell me your neighborhood (or the issue type: tires/brakes/transmission) and I’ll refine the list.";
      } else {
        baseReply =
          "I can find nearby shops, but I can’t determine your location precisely right now.\n" +
          "Enable GPS in the app and try again, or send your city/neighborhood.";
      }

      const reply = await rewriteToLocale(baseReply, locale);

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
                audio_ok: audioResult.ok,
              },
            }
          : {}),
      };
    }

    // 4) build model input
    const messageContent = [];

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

LANGUAGE_RULES:
- Respond ONLY in the user's language implied by LOCALE (no bilingual output unless the user explicitly requests bilingual).
- If mixed languages: use the language of the last user sentence.
- Never assume a fixed city/country. Use LOCATION only if provided; otherwise treat it as Global.

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
        text: "Use the photo naturally like you inspected the car. Identify visible wear/leaks/damage and tie it to the most probable diagnosis.",
      });
    }

    // 5) OpenAI response (guarded)
    const openAiCall = client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        { role: "system", content: FIXLENS_STYLE_INJECTOR },
        ...history.slice(-8),
        { role: "user", content: messageContent },
      ],
      temperature: 0.2,
    });

    // Timeout: prevent hanging “no reply until re-enter”
    const response = await withTimeout(openAiCall, 55000, null);

    if (!response) {
      let safeReply = fallbackMessageBase(locale);
      safeReply = await rewriteToLocale(safeReply, locale);
      return {
        ok: false,
        reply: safeReply,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode ? { debug: { stage: "timeout", model: process.env.FIXLENS_MODEL || "gpt-4o" } } : {}),
      };
    }

    const outRaw = response?.choices?.[0]?.message?.content || "";
    let out = ensureNonEmptyReply(outRaw, locale);

    // ensure output language matches locale
    out = await rewriteToLocale(out, locale);

    return {
      ok: true,
      reply: out,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      ...(debugMode ? { debug: { stage: "ok", model: process.env.FIXLENS_MODEL || "gpt-4o", audio_ok: audioResult.ok } } : {}),
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
