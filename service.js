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

  // Keep it short and professional. (For "all languages", we rely on model for main output.
  // This fallback is only for edge cases where model output is empty or services fail.)
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
  const locale = inferLocale({ locale: body.locale, text, history });

  // Location should be global-ready (earth-wide). App can send city/country or lat,lng later.
  const user_location = body.user_location || "Global";

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  try {
    // 1) transcribe audio (if any)
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;
    const fullInput = `${text} ${voiceText}`.trim();

    // 2) Local verified search from /data + optional Google Places
    let VERIFIED_DATA = [];
    let VERIFIED_WORKSHOPS = [];

    try {
      const searchPack = await performSearch(fullInput || text, user_location);
      VERIFIED_DATA = Array.isArray(searchPack?.verified_data) ? searchPack.verified_data : [];
      VERIFIED_WORKSHOPS = Array.isArray(searchPack?.verified_workshops)
        ? searchPack.verified_workshops
        : [];
    } catch (searchErr) {
      // IMPORTANT: never fail the whole request due to search/places.
      console.error("Search Error:", searchErr?.message || searchErr);
      VERIFIED_DATA = [];
      VERIFIED_WORKSHOPS = [];
    }

    // 3) Build user message content
    const messageContent = [];

    // Critical: tell the model to respond in the detected/specified locale,
    // and to keep language consistent (no mixed Arabic/English unless user asks).
    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${user_location}

LANGUAGE_RULES:
- Respond ONLY in the user's language implied by LOCALE (no bilingual output unless the user explicitly requests bilingual).
- If LOCALE is a region tag (e.g., ar-IQ), use that language naturally.
- If user asks for workshops/places, use VERIFIED_WORKSHOPS_JSON first. If empty, ask for city/neighborhood OR provide a safe generic selection checklist (still in same language).

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
    const out = ensureNonEmptyReply(outRaw, locale);

    return {
      ok: true,
      reply: out,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
    };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);

    // IMPORTANT: return error in user's language when possible
    const safeReply = fallbackMessage(locale);

    return {
      ok: false,
      reply: safeReply,
      locale,
      workshops_count: 0,
    };
  }
}
