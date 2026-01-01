// lib/service.js
import fs from "fs";
import path from "path";
import OpenAI from "openai";

// --------------------
// Models (safe defaults)
// --------------------
const MODEL_TEXT = process.env.MODEL_TEXT || "gpt-4o-mini";
const MODEL_VISION = process.env.MODEL_VISION || "gpt-4o-mini";
const MODEL_TRANSCRIBE = process.env.MODEL_TRANSCRIBE || "whisper-1";

// --------------------
// OpenAI client (never throw)
// --------------------
function getOpenAIClientOrNull() {
  try {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    return new OpenAI({ apiKey: key });
  } catch (e) {
    return null;
  }
}

// --------------------
// Language helpers
// --------------------
function isArabicText(s) {
  if (!s) return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(String(s));
}

function normalizeLang(code) {
  if (!code) return null;
  const c = String(code).trim();
  if (!c) return null;
  const first = c.split(",")[0].trim();
  if (!first) return null;

  const lower = first.toLowerCase();
  if (lower === "auto") return "auto";

  // allow: en, ar, ar-IQ, etc.
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(first)) return null;
  return first;
}

async function resolveLanguage({ preferredLanguage, message, transcriptText }) {
  const p = normalizeLang(preferredLanguage);
  if (p && p !== "auto") return p;
  const text = `${message || ""} ${transcriptText || ""}`.trim();
  return isArabicText(text) ? "ar" : "en";
}

// --------------------
// Output guards (no crash)
// --------------------
function normalizeOutput(s) {
  if (!s) return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function enforceNoLists(text) {
  // Remove common numbered/bulleted list patterns if model outputs them.
  // Keep it gentle: convert to one paragraph.
  const t = String(text || "").trim();
  if (!t) return t;

  // If it looks like a list, flatten it.
  const looksLikeList =
    /(^|\n)\s*[\-\*•]\s+/.test(t) || /(^|\n)\s*\(?\d+\)?\s*[\.\-:]/.test(t);

  if (!looksLikeList) return t;

  // Flatten lines into one paragraph, keep meaning.
  const flattened = t
    .split("\n")
    .map((l) => l.replace(/^\s*[\-\*•]\s+/, "").replace(/^\s*\(?\d+\)?\s*[\.\-:]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");

  return flattened.trim();
}

async function enforceLanguage(text, lang) {
  // Hard rule: do not change language. If mismatch is extreme, add a short localized line.
  const out = String(text || "").trim();
  if (!out) return out;

  const isAr = lang && String(lang).toLowerCase().startsWith("ar");
  const outHasArabic = isArabicText(out);

  if (isAr && !outHasArabic) {
    // Add a tiny Arabic lead-in, keep it minimal.
    return `تمام. ${out}`;
  }
  if (!isAr && outHasArabic) {
    // Keep English only
    // (we won't delete content aggressively; just return as-is)
    return out;
  }
  return out;
}

// --------------------
// History formatting (client-side history only)
// --------------------
function formatHistoryForPrompt(history) {
  if (!Array.isArray(history) || history.length === 0) return "(empty)";

  // Expected item shape could be:
  // { role: "user"|"assistant", text: "..."} OR { isUser: true/false, text: "..." }
  const lines = [];
  for (const item of history) {
    const role =
      item?.role ||
      (item?.isUser === true ? "user" : item?.isUser === false ? "assistant" : "user");
    const text = String(item?.text ?? item?.message ?? item?.content ?? "").trim();
    if (!text) continue;
    lines.push(`${role.toUpperCase()}: ${text}`);
  }
  return lines.length ? lines.join("\n") : "(empty)";
}

// --------------------
// Doctor prompt (your doctorPrompt.js idea + stronger no-list rule)
// --------------------
function buildDoctorMechanicProPrompt(lang) {
  const isAr = String(lang || "").toLowerCase().startsWith("ar");

  // Important: We tell the model to NEVER output bullets/numbering/steps.
  // One professional mechanic-style paragraph, ending with ONE short question only.
  return `
You are FixLens operating in Doctor Mechanic mode.

Rules (must follow):
- Do NOT explain concepts.
- Do NOT teach.
- Do NOT translate.
- Do NOT change the user's language.
- Focus only on real-world mechanical diagnosis.
- Be concise, confident, and practical.
- If input is unclear, infer intelligently.
- If certainty is high, state it calmly.
- Ask only ONE short follow-up question at the end.
- NEVER use lists, bullets, numbered steps, headings, or sections.
- Output must be a single paragraph (no line breaks).

Language:
- The user language is: ${isAr ? "Arabic" : "English"}.
- Reply strictly in that language.

Safety:
- If the situation sounds dangerous (brakes, fuel leak, smoke, overheating), tell the user to stop driving and seek a mechanic immediately, still as one paragraph.
`.trim();
}

// --------------------
// Data health (optional: you can expand later)
// --------------------
const DATA = {
  loaded: true,
  notes: "No external data files required.",
};

export function getDataHealth() {
  return {
    ok: true,
    loaded: !!DATA.loaded,
    notes: DATA.notes,
    timestamp: new Date().toISOString(),
  };
}

// --------------------
// OpenAI response helpers
// --------------------
function extractReplyFromResponse(resp) {
  // OpenAI Responses API may return output text in different shapes.
  // Try multiple safe paths without throwing.
  try {
    if (!resp) return "";
    if (typeof resp.output_text === "string") return resp.output_text;

    // Some SDKs return: resp.output[...].content[...].text
    const out = resp.output;
    if (Array.isArray(out)) {
      let text = "";
      for (const item of out) {
        const content = item?.content;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
            if (typeof c?.text === "string") text += c.text;
          }
        }
      }
      if (text.trim()) return text.trim();
    }

    // Fallback: JSON stringify
    return "";
  } catch {
    return "";
  }
}

// --------------------
// Diagnose TEXT
// --------------------
export async function diagnoseText({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();

  const lang = await resolveLanguage({ preferredLanguage, message });
  const historyText = formatHistoryForPrompt(history);

  const safeMessage = String(message || "").trim();
  const safeVehicle = String(vehicleInfo || "").trim();

  // If no OpenAI key, return clean message (no throw)
  if (!openai) {
    const reply = lang.startsWith("ar")
      ? "FixLens Brain غير نشط الآن لأن مفتاح OpenAI غير موجود على السيرفر. أضف OPENAI_API_KEY ثم جرّب مرة ثانية."
      : "FixLens Brain is not active because the OpenAI key is missing on the server. Add OPENAI_API_KEY and try again.";
    return { ok: false, reply, language: lang };
  }

  const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

VehicleInfo=${safeVehicle || "(not provided)"}

UserMessage=${safeMessage || "(no text provided)"}

Important:
- Use ConversationHistory as the source of truth for already-provided info.
- Do NOT ask for info that already exists in ConversationHistory.
- Ask ONE short question only at the end.
- Single paragraph only. No lists. No line breaks.
`.trim();

  try {
    const resp = await openai.responses.create({
      model: MODEL_TEXT,
      instructions: buildDoctorMechanicProPrompt(lang),
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
      temperature: 0.25,
      max_output_tokens: 900,
    });

    let raw = extractReplyFromResponse(resp);
    raw = normalizeOutput(raw);
    raw = enforceNoLists(raw);
    raw = await enforceLanguage(raw, lang);

    if (!raw) {
      raw = lang.startsWith("ar")
        ? "ما وصلتني تفاصيل كافية لتشخيص دقيق. اذكر الأعراض ومتى تظهر، وسأوجهك بخطوة واحدة الآن: هل يظهر التسريب وأنت توقف السيارة أم أثناء الحركة؟"
        : "I don’t have enough detail for a precise diagnosis. Tell me the symptoms and when it happens. One question: does the leak show while parked, or only after driving?";
      raw = enforceNoLists(raw);
      raw = await enforceLanguage(raw, lang);
    }

    return { ok: true, reply: raw, language: lang };
  } catch (err) {
    console.error("TEXT_OPENAI_ERROR:", err?.message || err);
    const reply = lang.startsWith("ar")
      ? "FixLens Brain واجه مشكلة مؤقتة أثناء التحليل. جرّب مرة ثانية الآن."
      : "FixLens Brain hit a temporary issue while analyzing. Please retry now.";
    return { ok: false, reply, language: lang };
  }
}

// --------------------
// Diagnose IMAGE
// --------------------
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  imageBuffer,
  imageMime,
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();

  const lang = await resolveLanguage({ preferredLanguage, message });
  const historyText = formatHistoryForPrompt(history);

  const safeMessage = String(message || "").trim();
  const safeVehicle = String(vehicleInfo || "").trim();

  if (!openai) {
    const reply = lang.startsWith("ar")
      ? "FixLens Brain غير نشط الآن لأن مفتاح OpenAI غير موجود على السيرفر. أضف OPENAI_API_KEY ثم جرّب مرة ثانية."
      : "FixLens Brain is not active because the OpenAI key is missing on the server. Add OPENAI_API_KEY and try again.";
    return { ok: false, reply, language: lang };
  }

  if (!imageBuffer || !(imageBuffer instanceof Buffer) || imageBuffer.length < 200) {
    const reply = lang.startsWith("ar")
      ? "الصورة غير واضحة أو لم تصل بشكل صحيح. أعد رفع الصورة بدقة أعلى."
      : "The image is missing or too small. Please upload a clearer image.";
    return { ok: false, reply, language: lang };
  }

  // Build prompt
  const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

VehicleInfo=${safeVehicle || "(not provided)"}

UserMessage=${safeMessage || "(no text provided)"}

Important:
- Use ConversationHistory as truth; don’t ask for already-provided info.
- Diagnose based on what is visible in the image + the text context.
- Ask ONE short question only at the end.
- Single paragraph only. No lists. No line breaks.
`.trim();

  const mime = String(imageMime || "image/jpeg");

  try {
    const base64 = imageBuffer.toString("base64");

    const resp = await openai.responses.create({
      model: MODEL_VISION,
      instructions: buildDoctorMechanicProPrompt(lang),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: userPrompt },
            {
              type: "input_image",
              image_url: `data:${mime};base64,${base64}`,
            },
          ],
        },
      ],
      temperature: 0.25,
      max_output_tokens: 1000,
    });

    let raw = extractReplyFromResponse(resp);
    raw = normalizeOutput(raw);
    raw = enforceNoLists(raw);
    raw = await enforceLanguage(raw, lang);

    if (!raw) {
      raw = lang.startsWith("ar")
        ? "لم أستطع استخراج تفاصيل كافية من الصورة. التقط صورة أقرب وبإضاءة أقوى. سؤال واحد: ما هو الجزء الذي تريدني أن أركز عليه في الصورة؟"
        : "I couldn’t extract enough detail from the image. Please retake it closer with better light. One question: which exact part should I focus on in the photo?";
      raw = enforceNoLists(raw);
      raw = await enforceLanguage(raw, lang);
    }

    return { ok: true, reply: raw, language: lang };
  } catch (err) {
    console.error("IMAGE_OPENAI_ERROR:", err?.message || err);
    const reply = lang.startsWith("ar")
      ? "FixLens Brain تعذر عليه تحليل الصورة الآن. جرّب مرة ثانية بعد لحظة."
      : "FixLens Brain couldn’t analyze the image right now. Please retry in a moment.";
    return { ok: false, reply, language: lang };
  }
}

// --------------------
// Audio helpers (safe, no ffmpeg requirement)
// --------------------
function extFromMimeOrName(mime, name) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg")) return "ogg";
  const n = String(name || "").toLowerCase();
  const ext = path.extname(n).replace(".", "");
  return ext || "wav";
}

async function transcribeAudioSafe(openai, audioBuffer, mime, originalName) {
  // We write to tmp file because whisper expects a file stream
  try {
    const ext = extFromMimeOrName(mime, originalName);
    const tmpPath = path.join(osTmp(), `fixlens_audio_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, audioBuffer);

    const stream = fs.createReadStream(tmpPath);

    const tr = await openai.audio.transcriptions.create({
      file: stream,
      model: MODEL_TRANSCRIBE,
    });

    try { fs.unlinkSync(tmpPath); } catch {}
    return String(tr?.text || "").trim();
  } catch (e) {
    return "";
  }
}

function osTmp() {
  // no import os to keep file minimal; fallback to /tmp
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
}

// --------------------
// Diagnose AUDIO
// --------------------
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  audioBuffer,
  audioMime,
  audioOriginalName,
  mode = "doctor",
}) {
  const openai = getOpenAIClientOrNull();

  // If buffer missing, never throw
  if (!audioBuffer || !(audioBuffer instanceof Buffer) || audioBuffer.length < 200) {
    const lang = await resolveLanguage({ preferredLanguage, message });
    const reply = lang.startsWith("ar")
      ? "الصوت لم يصل أو كان قصيراً جداً. سجّل 5–10 ثواني قرب مصدر الصوت وأعد الإرسال. سؤال واحد: هل الصوت يظهر عند التشغيل البارد أم بعد السخونة؟"
      : "The audio didn’t arrive or was too short. Record 5–10 seconds near the sound source and resend. One question: does it happen on cold start or after warm-up?";
    return { ok: false, reply: enforceNoLists(reply), language: lang, transcript: null };
  }

  const transcriptText = openai
    ? await transcribeAudioSafe(openai, audioBuffer, audioMime, audioOriginalName)
    : "";

  const lang = await resolveLanguage({ preferredLanguage, message, transcriptText });
  const historyText = formatHistoryForPrompt(history);

  if (!openai) {
    const reply = lang.startsWith("ar")
      ? "FixLens Brain غير نشط الآن لأن مفتاح OpenAI غير موجود على السيرفر. أضف OPENAI_API_KEY ثم جرّب مرة ثانية."
      : "FixLens Brain is not active because the OpenAI key is missing on the server. Add OPENAI_API_KEY and try again.";
    return { ok: false, reply, language: lang, transcript: transcriptText || null };
  }

  const safeMessage = String(message || "").trim();
  const safeVehicle = String(vehicleInfo || "").trim();

  const userPrompt = `
UserLanguage=${lang}
ConversationHistory:
${historyText}

Transcript=${transcriptText ? transcriptText : "(no clear speech detected)"}
VehicleInfo=${safeVehicle || "(not provided)"}
UserText=${safeMessage || "(no text provided)"}

Important:
- Use ConversationHistory as truth; do not ask for what already exists.
- If Transcript is empty, do NOT invent speech.
- Diagnose based on the described sound + context.
- Ask ONE short question only at the end.
- Single paragraph only. No lists. No line breaks.
`.trim();

  try {
    const resp = await openai.responses.create({
      model: MODEL_TEXT,
      instructions: buildDoctorMechanicProPrompt(lang),
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }],
        },
      ],
      temperature: 0.25,
      max_output_tokens: 1000,
    });

    let raw = extractReplyFromResponse(resp);
    raw = normalizeOutput(raw);
    raw = enforceNoLists(raw);
    raw = await enforceLanguage(raw, lang);

    if (!raw) {
      raw = lang.startsWith("ar")
        ? "ما قدرت أحدد الصوت بدقة من التسجيل الحالي. جرّب تسجيل أقرب بدون ريح. سؤال واحد: الصوت نقر/طقطقة أم أزيز/صفير؟"
        : "I couldn’t identify the sound precisely from this recording. Please record closer with less wind noise. One question: is it a knock/tick or a whine/squeal?";
      raw = enforceNoLists(raw);
      raw = await enforceLanguage(raw, lang);
    }

    return {
      ok: true,
      reply: raw,
      language: lang,
      transcript: transcriptText || null,
    };
  } catch (err) {
    console.error("AUDIO_OPENAI_ERROR:", err?.message || err);
    const reply = lang.startsWith("ar")
      ? "FixLens Brain تعذر عليه تحليل الصوت الآن. جرّب مرة ثانية بعد لحظة."
      : "FixLens Brain couldn’t analyze the audio right now. Please retry in a moment.";
    return { ok: false, reply, language: lang, transcript: transcriptText || null };
  }
}
