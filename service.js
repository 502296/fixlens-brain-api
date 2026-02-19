// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LOCATION NORMALIZATION (prevents "Global" / empty bias)
========================================================= */
function normalizeUserLocation(raw) {
  if (!raw) return "";

  if (typeof raw === "string") {
    const v = raw.trim();
    if (!v) return "";
    if (v.toLowerCase() === "global") return "";
    return v;
  }

  if (typeof raw === "object") {
    // Accept {lat,lng} or {latitude,longitude} or {city,state,country}
    return raw;
  }

  return "";
}

function stringifyLocation(loc) {
  if (!loc) return "";
  if (typeof loc === "string") return loc.trim();
  try {
    return JSON.stringify(loc);
  } catch {
    return String(loc);
  }
}

/* =========================================================
   LANGUAGE (simple + safe)
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

function localeToLang(locale) {
  const v = String(locale || "").trim();
  if (!v) return "en";
  return v.split("-")[0].toLowerCase() || "en";
}

/* =========================================================
   TIMEOUT + RETRY (stable)
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

function isTransientError(e) {
  const msg = String(e?.message || "").toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("429") ||
    msg.includes("rate")
  );
}

async function withRetry(fn, tries = 2, baseDelay = 250) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (!isTransientError(e) || i === tries - 1) throw e;
      await sleep(baseDelay * (i + 1));
    }
  }
  throw lastErr;
}

/* =========================================================
   AUDIO TRANSCRIPTION (safe: transcript is NOT diagnosis)
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
          // keep it neutral (no guessing smells / causes)
          prompt: "Transcribe the audio only. Do not guess causes. If unclear, output the closest transcript.",
        }),
        Number(process.env.WHISPER_TIMEOUT_MS || 15000),
        "whisper_timeout"
      )
    );

    const text = String(result?.text || "").trim();
    // Heuristic: treat very short transcripts as unreliable
    const ok = Boolean(text) && text.length >= 6;
    return { text, ok };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false };
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

/* =========================================================
   PLACES INTENT (IMPORTANT)
   - typed text only (audio NEVER triggers places)
   - smart continuation: if last user asked places and now sent only location => still places
========================================================= */
function looksLikePlacesRequest(text = "") {
  const t = String(text || "").toLowerCase();

  // Arabic
  if (
    t.includes("ورشة") ||
    t.includes("ميكاني") ||
    t.includes("ميكانيكي") ||
    t.includes("كراج") ||
    t.includes("محل") ||
    t.includes("عنوان") ||
    t.includes("اقرب") ||
    t.includes("أقرب") ||
    t.includes("قريب") ||
    t.includes("خرائط") ||
    t.includes("اطارات") ||
    t.includes("إطارات") ||
    t.includes("قطع غيار") ||
    t.includes("محل قطع") ||
    t.includes("ادوات") ||
    t.includes("أدوات")
  )
    return true;

  // English
  if (
    t.includes("mechanic") ||
    t.includes("garage") ||
    t.includes("auto repair") ||
    t.includes("repair shop") ||
    t.includes("tire shop") ||
    t.includes("tyre shop") ||
    t.includes("address") ||
    t.includes("near me") ||
    t.includes("nearby") ||
    t.includes("google maps") ||
    t.includes("parts store") ||
    t.includes("auto parts") ||
    t.includes("hardware store") ||
    t.includes("tool store")
  )
    return true;

  // ZIP pattern often indicates places
  if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true;

  return false;
}

// detects "location-only" message (Louisville Kentucky / 40218 / "I am in ...")
function looksLikeLocationOnly(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  // if it's only zip
  if (/^\d{5}(?:-\d{4})?$/.test(t)) return true;

  // if it looks like city/state words and not diagnostic symptom words
  const lower = t.toLowerCase();
  const locationHints = [
    "kentucky",
    "louisville",
    "ky",
    "usa",
    "united states",
    "i am in",
    "i'm in",
    "in ",
    "في ",
    "انا في",
    "أني في",
  ];
  const symptomWords = ["noise", "vibration", "check engine", "overheat", "smoke", "stall", "تقطيع", "صوت", "رجّة", "حرارة", "دخان"];
  const hasLoc = locationHints.some((w) => lower.includes(w));
  const hasSymptom = symptomWords.some((w) => lower.includes(w));
  return hasLoc && !hasSymptom;
}

function lastUserAskedPlaces(history = []) {
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

    return looksLikePlacesRequest(text);
  }
  return false;
}

/* =========================================================
   RESPONSE TEXT HELPERS
========================================================= */
function fallbackMessage(locale) {
  const lang = localeToLang(locale);
  if (lang === "ar") return "صار خلل بسيط. اكتب (نوع السيارة + السنة + الأعراض + متى تظهر) وأمشيك بخطة فحص دقيقة.";
  return "A temporary issue occurred. Send (car make/model + year + symptoms + when it happens) and I’ll give a precise check plan.";
}

function formatPlacesList(locale, items = []) {
  const lang = localeToLang(locale);
  const top = items.slice(0, 5);

  if (top.length === 0) {
    return lang === "ar"
      ? "ما لكيت نتائج قريبة الآن. فعّل GPS أو اكتب ZIP/المدينة + الولاية حتى أجيب لك نتائج دقيقة."
      : "No nearby results right now. Enable GPS or send ZIP/city+state for accurate results.";
  }

  const lines = top
    .map((w, i) => {
      const name = w?.name || (lang === "ar" ? "مكان" : "Place");
      const address = w?.address ? `\n${lang === "ar" ? "العنوان" : "Address"}: ${w.address}` : "";
      const rating =
        w?.rating ? `\n${lang === "ar" ? "التقييم" : "Rating"}: ${w.rating}${w?.ratings_total ? ` (${w.ratings_total})` : ""}` : "";
      const phone = w?.phone ? `\n${lang === "ar" ? "الهاتف" : "Phone"}: ${w.phone}` : "";
      const maps = w?.maps_url ? `\nGoogle: ${w.maps_url}` : "";
      const priceHint = w?.price_hint ? `\n${lang === "ar" ? "تقريب السعر" : "Price hint"}: ${w.price_hint}` : "";

      return `${i + 1}) ${name}${address}${rating}${phone}${priceHint}${maps}`;
    })
    .join("\n\n");

  const header =
    lang === "ar"
      ? "هذه نتائج قريبة حسب موقعك:"
      : "Here are nearby results based on your location:";

  const footer =
    lang === "ar"
      ? "\n\nإذا تكتب نوع الطلب (قطع غيار/أدوات/إطارات/فرامل) أرتّب لك نتائج أدق."
      : "\n\nIf you tell me what you need (parts/tools/tires/brakes) I can refine the list.";

  return `${header}\n\n${lines}${footer}`;
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "");
  const history = Array.isArray(body.history) ? body.history : [];

  let locale = inferLocale({ locale: body.locale, text });

  const user_location = normalizeUserLocation(body.user_location); // "" | string | object
  const effective_location = stringifyLocation(user_location) || "Global";

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  const debugMode = Boolean(body.debug);

  try {
    // Empty guard
    if (!text.trim() && !audio_base_64 && !image_base_64) {
      return {
        ok: false,
        reply: fallbackMessage(locale),
        locale,
        workshops_count: 0,
        ...(debugMode ? { debug: { stage: "empty_input" } } : {}),
      };
    }

    // AUDIO
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.ok ? audioResult.text : "";

    // IMPORTANT: places intent from typed text only
    const placesFromTyped = looksLikePlacesRequest(text);
    const priorPlaces = lastUserAskedPlaces(history);
    const locationOnly = looksLikeLocationOnly(text);

    // smart: if prior was places and now user only sent location -> treat as places
    const isPlaces = placesFromTyped || (priorPlaces && locationOnly);

    // SEARCH: pass typed text (not audio) for places decision,
    // but allow KB to use both if needed.
    const queryForKB = `${text} ${voiceText}`.trim();
    const queryForPlaces = text.trim();

    const searchPack = await withRetry(() =>
      withTimeout(
        performSearch(queryForKB || text, user_location, {
          locale,
          allowPlaces: isPlaces,
          placesQueryOverride: queryForPlaces, // ✅ makes places use typed text only
          placesRadiusMeters: Number(body.places_radius_meters || 25000),
        }),
        Number(process.env.SEARCH_TIMEOUT_MS || 15000),
        "search_timeout"
      )
    );

    const VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
    const VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops) ? searchPack.verified_workshops : [];

    // PLACES SHORT-CIRCUIT
    if (isPlaces) {
      const reply = formatPlacesList(locale, VERIFIED_WORKSHOPS);

      return {
        ok: true,
        reply,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
        ...(debugMode
          ? {
              debug: {
                stage: "places",
                effective_location,
                has_gps: typeof user_location === "object",
                places_from_typed: placesFromTyped,
                prior_places: priorPlaces,
                location_only: locationOnly,
                workshops_count: VERIFIED_WORKSHOPS.length,
              },
            }
          : {}),
      };
    }

    // DIAGNOSIS MODE (build strict prompt)
    const lang = localeToLang(locale);

    const audioNote =
      audio_base_64 && !audioResult.ok
        ? (lang === "ar"
            ? "ملاحظة صوت: التسجيل غير واضح. إذا تقدر أعد تسجيل 10–15 ثانية قريب من مصدر الصوت."
            : "Audio note: unclear. If possible, re-record 10–15s close to the source.")
        : "";

    const payload = {
      LOCALE: locale,
      USER_LOCATION: effective_location,
      USER_INPUT: text.trim(),
      AUDIO_TRANSCRIPT_OK: audioResult.ok ? "YES" : audio_base_64 ? "NO" : "NO_AUDIO",
      AUDIO_TRANSCRIPT: voiceText || "",
      AUDIO_NOTE: audioNote,
      VERIFIED_DATA_JSON: VERIFIED_DATA,
    };

    const response = await withRetry(() =>
      withTimeout(
        client.chat.completions.create({
          model: process.env.FIXLENS_MODEL || "gpt-4o",
          messages: [
            { role: "system", content: buildDoctorSystemPrompt() },
            ...history.slice(-6),
            {
              role: "user",
              content:
                `STRICT_CONTEXT\n` +
                `- Respond ONLY in the language implied by LOCALE.\n` +
                `- Do NOT invent facts.\n` +
                `- If AUDIO_TRANSCRIPT_OK=NO, do NOT base diagnosis on audio.\n` +
                `- Give ranked likely causes + exact next checks.\n\n` +
                `${JSON.stringify(payload)}`,
            },
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
      workshops_count: 0,
      ...(debugMode ? { debug: { stage: "ok", effective_location } } : {}),
    };
  } catch (error) {
    console.error("FixLens Fatal:", error?.message || error);
    return {
      ok: false,
      reply: fallbackMessage(locale),
      locale,
      workshops_count: 0,
      ...(debugMode ? { debug: { stage: "catch", message: String(error?.message || "") } } : {}),
    };
  }
}
