// lib/service.js
import OpenAI from "openai";
import { doctorPrompt } from "./doctorPrompt.js";

/* =========================
   Models (override via ENV)
========================= */
const MODEL_TEXT = process.env.MODEL_TEXT || "gpt-4o-mini";
const MODEL_VISION = process.env.MODEL_VISION || "gpt-4o-mini";
const MODEL_TRANSCRIBE = process.env.MODEL_TRANSCRIBE || "whisper-1";

/* =========================
   OpenAI client
========================= */
function getOpenAIClientOrNull() {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !String(key).trim()) return null;
  return new OpenAI({ apiKey: String(key).trim() });
}

/* =========================
   Small helpers
========================= */
function safeTrim(s) {
  return (s ?? "").toString().trim();
}

function looksArabic(s) {
  return /[\u0600-\u06FF]/.test(s || "");
}

function normalizeLang(code) {
  const c = safeTrim(code);
  if (!c) return null;
  const first = c.split(",")[0].trim();
  if (!first) return null;
  if (first.toLowerCase() === "auto") return "auto";
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(first)) return null;
  return first;
}

async function resolveLanguage({ preferredLanguage, message, transcriptText }) {
  const p = normalizeLang(preferredLanguage);
  if (p && p !== "auto") return p;

  // if user typed Arabic or transcript Arabic => ar
  if (looksArabic(message) || looksArabic(transcriptText)) return "ar";

  // default
  return "en";
}

function extractOutputText(resp) {
  // OpenAI Responses API: prefer output_text if present, else walk output blocks.
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text;

  const out = resp.output || [];
  let text = "";
  for (const item of out) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        text += (text ? "\n" : "") + c.text;
      }
    }
  }
  return text;
}

function formatHistoryForPrompt(history) {
  if (!Array.isArray(history) || history.length === 0) return "(none)";
  // Expect items like: { role: "user"|"assistant", text: "..." }
  // We keep it compact to help the model stay on-session.
  const lines = [];
  for (const h of history) {
    const role = (h?.role || "").toString().toLowerCase();
    const txt = safeTrim(h?.text ?? h?.message ?? h?.content);
    if (!txt) continue;
    if (role === "assistant") lines.push(`Assistant: ${txt}`);
    else lines.push(`User: ${txt}`);
  }
  return lines.length ? lines.join("\n") : "(none)";
}

function buildDoctorMechanicInstructions(lang) {
  // Your doctorPrompt is already strict. We add only what helps session + one question.
  // Keep it short so it doesn’t “teach”.
  return `
${doctorPrompt}

Hard rules:
- Always reply in UserLanguage.
- Use ConversationHistory as source of truth; do not restart the session.
- Never ask for info that already exists in ConversationHistory.
- Ask ONLY ONE short follow-up question at the end (or none if certainty is high).
`.trim();
}

function enforceLanguageHard(text, lang) {
  const t = safeTrim(text);
  if (!t) return t;

  if (lang?.startsWith("ar")) {
    // If model accidentally returned English, force a short Arabic fallback.
    if (!looksArabic(t)) {
      return "أحتاج تفاصيل أكثر حتى أشخّص بدقة. ما هو طراز سيارتك والسنة، ومتى يظهر العَرَض بالضبط؟";
    }
    return t;
  }

  // English fallback if it came Arabic by mistake
  if (looksArabic(t)) {
    return "I need a bit more detail to diagnose accurately. What’s the year/make/model, and exactly when does the symptom happen?";
  }

  return t;
}

function localizedKeyMissing(lang) {
  return lang?.startsWith("ar")
    ? "FixLens Brain غير مفعل لأن مفتاح OpenAI غير موجود على السيرفر. أضف OPENAI_API_KEY في Railway ثم أعد التشغيل."
    : "FixLens Brain is not active because the OpenAI key is missing on the server. Add OPENAI_API_KEY in Railway and restart.";
}

function localizedImageFail(lang) {
  return lang?.startsWith("ar")
    ? "ما قدرت أحلل الصورة الآن. أعد الإرسال بصورة أوضح وبإضاءة أقوى."
    : "I couldn’t analyze the image right now. Please resend a clearer photo with better lighting.";
}

function localizedAudioFail(lang) {
  return lang?.startsWith("ar")
    ? "ما قدرت ألتقط صوت واضح من التسجيل. حاول مرة ثانية وقرب المايك من مصدر الصوت داخل السيارة."
    : "I couldn’t capture clear sound from the recording. Please try again and get closer to the noise source in the car.";
}

/* =========================
   Data health (optional)
========================= */
export function getDataHealth() {
  // Keep it simple & always safe.
  return {
    ok: true,
    models: { MODEL_TEXT, MODEL_VISION, MODEL_TRANSCRIBE },
    hasKey: !!(process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim()),
    ts: new Date().toISOString(),
  };
}

/* =========================
   TEXT diagnose
========================= */
export async function diagnoseText({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();
  const lang = await resolveLanguage({ preferredLanguage, message });

  if (!openai) {
    return { ok: false, reply: localizedKeyMissing(lang), language: lang };
  }

  const historyText = formatHistoryForPrompt(history);
  const userText = safeTrim(message);

  const userPrompt = `
UserLanguage=${lang}
Mode=${mode || "doctor"}
ConversationHistory:
${historyText}

VehicleInfo=${safeTrim(vehicleInfo) || "(none)"}

UserMessage=${userText || "(no text provided)"}
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstructions(lang),
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    temperature: 0.2,
    max_output_tokens: 900,
  });

  const raw = extractOutputText(resp);
  const fixed = enforceLanguageHard(raw, lang);

  return { ok: true, reply: fixed, language: lang };
}

/* =========================
   IMAGE diagnose (Vision)
========================= */
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  imageBuffer,
  imageMime = "image/jpeg",
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();
  const lang = await resolveLanguage({ preferredLanguage, message });

  if (!openai) {
    return { ok: false, reply: localizedKeyMissing(lang), language: lang };
  }

  if (!imageBuffer || !(imageBuffer instanceof Buffer) || imageBuffer.length < 200) {
    return { ok: false, reply: localizedImageFail(lang), language: lang };
  }

  const historyText = formatHistoryForPrompt(history);
  const userText = safeTrim(message);

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${imageMime || "image/jpeg"};base64,${base64}`;

  const userPrompt = `
UserLanguage=${lang}
Mode=${mode || "doctor"}
ConversationHistory:
${historyText}

VehicleInfo=${safeTrim(vehicleInfo) || "(none)"}

UserMessage=${userText || "(no text provided)"}

Task: Diagnose based on the image + context. Do NOT teach. End with ONE short question only if needed.
`.trim();

  try {
    const resp = await openai.responses.create({
      model: MODEL_VISION,
      instructions: buildDoctorMechanicInstructions(lang),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: userPrompt },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      temperature: 0.2,
      max_output_tokens: 1000,
    });

    const raw = extractOutputText(resp);
    const fixed = enforceLanguageHard(raw, lang);

    return { ok: true, reply: fixed, language: lang };
  } catch (e) {
    // If vision fails for any reason, return a useful fallback.
    return { ok: false, reply: localizedImageFail(lang), language: lang, details: e?.message || String(e) };
  }
}

/* =========================
   AUDIO diagnose (Transcribe then diagnose)
========================= */
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  audioBuffer,
  audioMime = "audio/m4a",
  audioOriginalName = "audio.m4a",
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();

  // Determine lang after transcript if possible, but start with message
  let lang = await resolveLanguage({ preferredLanguage, message });

  if (!openai) {
    return { ok: false, reply: localizedKeyMissing(lang), language: lang, transcript: null };
  }

  if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length < 200) {
    return { ok: false, reply: localizedAudioFail(lang), language: lang, transcript: null };
  }

  // 1) Transcribe
  let transcriptText = "";
  try {
    // OpenAI SDK expects a File-like; Node supports Blob in recent runtimes.
    const blob = new Blob([audioBuffer], { type: audioMime || "audio/m4a" });

    const tr = await openai.audio.transcriptions.create({
      model: MODEL_TRANSCRIBE,
      file: blob,
      // language is optional; let it auto-detect
    });

    transcriptText = safeTrim(tr?.text);
  } catch (e) {
    transcriptText = "";
  }

  // Re-resolve language using transcript too
  lang = await resolveLanguage({ preferredLanguage, message, transcriptText });

  // If no transcript, still try diagnosing from audio presence? (We avoid inventing.)
  const transcriptLooksEmpty = !transcriptText || transcriptText.length < 6;
  if (transcriptLooksEmpty) {
    return { ok: false, reply: localizedAudioFail(lang), language: lang, transcript: null };
  }

  // 2) Diagnose using transcript + message + history
  const historyText = formatHistoryForPrompt(history);
  const userText = safeTrim(message);

  const userPrompt = `
UserLanguage=${lang}
Mode=${mode || "doctor"}
ConversationHistory:
${historyText}

VehicleInfo=${safeTrim(vehicleInfo) || "(none)"}

Transcript=${transcriptText}

TypedContext=${userText || "(no extra text provided)"}

Task: Diagnose based on transcript + context. Do NOT teach. Do NOT use lists. End with ONE short question only if needed.
`.trim();

  const resp = await openai.responses.create({
    model: MODEL_TEXT,
    instructions: buildDoctorMechanicInstructions(lang),
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    ],
    temperature: 0.2,
    max_output_tokens: 1100,
  });

  const raw = extractOutputText(resp);
  const fixed = enforceLanguageHard(raw, lang);

  return { ok: true, reply: fixed, language: lang, transcript: transcriptText };
}
