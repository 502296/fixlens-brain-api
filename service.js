// service.js — FixLens Doctor Brain (Global + Smart Places + Parts/Tools + PriceLevel)
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LOCATION NORMALIZATION (prevents "Global" bug)
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

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v || v.toLowerCase() === "auto") return "";
  return v;
}

function localeToLangTag(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

/* =========================================================
   LANGUAGE DETECTION (simple + reliable)
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");

  // Arabic
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(t)) return "ar";
  // Cyrillic (ru/uk/bg/etc)
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Japanese
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Korean
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  // Chinese
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

  return "en";
}

function inferLocale({ locale, text, history }) {
  const normalized = normalizeLocale(locale);
  if (normalized) return normalized;

  // Prefer last user message language if history exists
  if (Array.isArray(history) && history.length) {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg?.role !== "user") continue;
      const c = msg?.content;
      let s = "";
      if (typeof c === "string") s = c;
      else if (Array.isArray(c)) s = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");
      const lang = detectTextLanguage(s);
      if (lang) return lang;
    }
  }

  return detectTextLanguage(text || "") || "en";
}

/* =========================================================
   RELIABILITY (timeout + retry with small backoff)
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

async function withRetry(fn, tries = 2, baseDelayMs = 250) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || "");
      const transient =
        msg.includes("timeout") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("ECONNRESET") ||
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("429") ||
        msg.includes("rate") ||
        msg.includes("temporar");

      if (!transient || i === tries - 1) throw e;
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastErr || new Error("retry_failed");
}

/* =========================================================
   AUDIO TRANSCRIPTION (whisper)
========================================================= */
async function transcribeAudio(audioBase64) {
  if (!audioBase64 || String(audioBase64).length < 50) return { text: "", ok: false };

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
          prompt:
            "Automotive audio. Short transcript. Identify key words, symptom terms, and sound description if present.",
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = (result?.text || "").trim();
    return { text, ok: Boolean(text) };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

/* =========================================================
   INTENT DETECTION (Places + Parts/Tools) — typed-text only
========================================================= */
function looksLikePlacesRequestTyped(input = "") {
  const t = String(input || "").toLowerCase();

  // mechanic/shops
  const shop = [
    "workshop",
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "google maps",
    "map",
    "ورشة",
    "ورش",
    "ميكاني",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "وين اروح",
  ];

  // parts/tools stores
  const parts = [
    "auto parts",
    "car parts",
    "parts store",
    "tool store",
    "hardware store",
    "autozone",
    "o'reilly",
    "oreilly",
    "advance auto",
    "napa",
    "قطع غيار",
    "محل قطع",
    "محل قطع غيار",
    "محل ادوات",
    "محل أدوات",
    "ادوات",
    "أدوات",
  ];

  if (/\b\d{5}(?:-\d{4})?\b/.test(t) && (t.includes("near") || t.includes("قريب") || t.includes("اقرب"))) return true;

  return shop.some((w) => t.includes(w)) || parts.some((w) => t.includes(w));
}

// If last user asked for places, and current message is "location only" → continue places
function lastUserAskedForPlaces(history = []) {
  if (!Array.isArray(history) || history.length === 0) return false;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;

    const c = msg?.content;
    let text = "";
    if (typeof c === "string") text = c;
    else if (Array.isArray(c)) text = c.map((x) => (typeof x?.text === "string" ? x.text : "")).join(" ");

    text = String(text || "").trim();
    if (!text) continue;

    return looksLikePlacesRequestTyped(text);
  }
  return false;
}

function looksLikeLocationHintOnly(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // ZIP only or contains ZIP
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(t);

  const arHints = ["انا في", "أني في", "موقعي", "بالمنطقة", "بالحي", "شارع", "طريق", "قرب", "قريب من", "بال"];
  const enHints = ["i am in", "i’m in", "i'm in", "my location", "street", "st ", "road", "rd", "ave", "blvd"];

  const hintWord = arHints.some((w) => t.includes(w)) || enHints.some((w) => t.includes(w));

  // if it is NOT itself a places request (just location)
  const notExplicitPlaces = !looksLikePlacesRequestTyped(t);

  return (hasZip || hintWord) && notExplicitPlaces;
}

/* =========================================================
   REPLY HELPERS
========================================================= */
function fallbackMessage(locale) {
  const lang = localeToLangTag(locale);
  if (lang === "ar") {
    return "صار خلل بسيط. اكتب: (نوع السيارة + السنة + الأعراض + متى تظهر) وأنا أعطيك خطة فحص دقيقة.";
  }
  return "A temporary issue occurred. Send: (car make/model + year + symptoms + when it happens) and I’ll give a precise check plan.";
}

function formatPlacesList(locale, workshops = []) {
  const lang = localeToLangTag(locale);

  // Determine type label (parts/tools vs mechanic) if mode exists
  const mode = workshops?.[0]?.mode || "";
  const isParts = mode === "parts_tools";

  const headerAr = isParts ? "هذه محلات قطع غيار/أدوات قريبة حسب موقعك:" : "هذه ورش/ميكانيك قريبة حسب موقعك:";
  const headerEn = isParts ? "Here are nearby auto parts/tools stores:" : "Here are nearby mechanic shops:";

  const lines = workshops.slice(0, 5).map((w, i) => {
    const name = w?.name || (isParts ? "Parts Store" : "Shop");
    const address = w?.address ? (lang === "ar" ? `\nالعنوان: ${w.address}` : `\nAddress: ${w.address}`) : "";
    const rating =
      w?.rating && Number(w.rating) > 0
        ? lang === "ar"
          ? `\nالتقييم: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} مراجعة)` : ""}`
          : `\nRating: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total} reviews)` : ""}`
        : "";
    const phone = w?.phone ? (lang === "ar" ? `\nالهاتف: ${w.phone}` : `\nPhone: ${w.phone}`) : "";
    const price =
      w?.price_label
        ? lang === "ar"
          ? `\nمستوى السعر: ${w.price_label}${w?.price_meaning ? ` (${w.price_meaning})` : ""}`
          : `\nPrice level: ${w.price_label}${w?.price_meaning ? ` (${w.price_meaning})` : ""}`
        : "";
    const maps = w?.maps_url ? (lang === "ar" ? `\nخرائط Google: ${w.maps_url}` : `\nGoogle Maps: ${w.maps_url}`) : "";

    return `${i + 1}) ${name}${address}${rating}${phone}${price}${maps}`;
  });

  const tailAr = "إذا تكتب اسم المنطقة/الحي أو نوع الطلب (قطع غيار/إطارات/فرامل) أرتّب لك نتائج أدق.";
  const tailEn = "If you share your area/neighborhood or what you need (parts/tires/brakes), I can refine the results.";

  return (lang === "ar" ? headerAr : headerEn) + "\n\n" + lines.join("\n\n") + "\n\n" + (lang === "ar" ? tailAr : tailEn);
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "");
  const history = Array.isArray(body.history) ? body.history : [];

  // locale lock: trust body.locale if present; else infer from typed text/history
  let locale = inferLocale({ locale: body.locale, text, history });

  const user_location = normalizeUserLocation(body.user_location);
  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
  const debugMode = Boolean(body.debug);

  try {
    // Guard empty
    if (!text.trim() && !audio_base_64 && !image_base_64) {
      return { ok: false, reply: fallbackMessage(locale), locale, workshops_count: 0 };
    }

    // Audio transcript for diagnosis context only
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text || "";

    const fullInput = `${text} ${voiceText}`.trim();

    // ✅ Places intent from typed text ONLY (prevents Whisper mis-routing)
    const placesIntentTyped = looksLikePlacesRequestTyped(text);
    const priorPlaces = lastUserAskedForPlaces(history);
    const locationHintOnly = looksLikeLocationHintOnly(text);
    const placesIntentSmart = placesIntentTyped || (priorPlaces && locationHintOnly);

    // Search:
    // - For KB relevance & diagnosis: use fullInput (typed + audio)
    // - For Places: allowPlaces uses smart intent from typed text
    const queryForSearch = fullInput || text;

    let searchPack = { verified_data: [], verified_workshops: [] };
    try {
      searchPack = await withRetry(() =>
        withTimeout(
          performSearch(queryForSearch, user_location, {
            locale,
            allowPlaces: Boolean(placesIntentSmart),
            // optional tuning
            placesRadiusMeters: Number(body.places_radius_meters || 25000),
            maxResults: Number(body.max_results || 3),
          }),
          Number(process.env.SEARCH_TIMEOUT_MS || 15000),
          "search_timeout"
        )
      );
    } catch (e) {
      console.error("Search Error:", e?.message || e);
      searchPack = { verified_data: [], verified_workshops: [] };
    }

    const VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
    const VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops) ? searchPack.verified_workshops : [];

    // ✅ Places short-circuit (shops / parts/tools)
    if (placesIntentSmart) {
      if (VERIFIED_WORKSHOPS.length === 0) {
        const lang = localeToLangTag(locale);
        const msg =
          lang === "ar"
            ? "ما ظهرت نتائج قريبة الآن. فعّل GPS أو اكتب (ZIP/المدينة + المنطقة) وأعيد لك قائمة أدق."
            : "No nearby results right now. Enable GPS or send (ZIP/city + area) and I’ll refine the list.";
        return {
          ok: true,
          reply: msg,
          locale,
          workshops_count: 0,
          ...(debugMode ? { debug: { stage: "places_no_results", placesIntentSmart, placesIntentTyped, priorPlaces, locationHintOnly } } : {}),
        };
      }

      return {
        ok: true,
        reply: formatPlacesList(locale, VERIFIED_WORKSHOPS),
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode ? { debug: { stage: "places_ok", placesIntentSmart, placesIntentTyped, priorPlaces, locationHintOnly } } : {}),
      };
    }

    // ✅ Diagnostic mode (doctor brain)
    const messageContent = [];

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${typeof user_location === "string" ? user_location : JSON.stringify(user_location)}

RULES:
- Reply ONLY in LOCALE language (no bilingual).
- Worldwide: do not assume country/city unless provided.
- Be specific and actionable. Avoid filler.
- Ask at most ONE follow-up question only if it changes diagnosis.
- If audio transcript is empty/weak, ask for re-recording (10–15s) near the source, not guess.

AUDIO_TRANSCRIPT_OK: ${audioResult.ok ? "YES" : audio_base_64 ? "NO" : "NO_AUDIO"}
AUDIO_TRANSCRIPT: ${voiceText || ""}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}

USER_INPUT: ${text.trim()}`,
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text: "Use the photo to detect visible leaks, cracks, wear, residue, loose parts. Tie findings to the most probable cause.",
      });
    }

    const response = await withRetry(() =>
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
      )
    );

    const reply =
      response?.choices?.[0]?.message?.content?.trim() ||
      fallbackMessage(locale);

    return {
      ok: true,
      reply,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
      ...(debugMode ? { debug: { stage: "diagnose_ok", model: process.env.FIXLENS_MODEL || "gpt-4o" } } : {}),
    };
  } catch (error) {
    console.error("FixLens Fatal:", error?.message || error);
    return {
      ok: false,
      reply: fallbackMessage(locale),
      locale,
      workshops_count: 0,
    };
  }
}
