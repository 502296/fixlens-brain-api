// service.js
const PROMPT_VERSION = "doctorPrompt_v2026_dynamic_1";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================
// Helpers
// =====================
function cleanBase64(b64 = "") {
  return String(b64)
    .replace(/^data:audio\/[a-zA-Z0-9.+-]+;base64,/, "")
    .replace(/^data:application\/octet-stream;base64,/, "")
    .trim();
}

function detectByScript(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  return "en";
}

function normalizeLocale(loc) {
  if (!loc) return "";
  const s = String(loc).trim().toLowerCase();
  if (s.startsWith("ar")) return "ar";
  if (s.startsWith("en")) return "en";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("fr")) return "fr";
  if (s.startsWith("de")) return "de";
  if (s.startsWith("it")) return "it";
  return s.length <= 8 ? s : "";
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return "";
        if (typeof c === "string") return c;
        if (c.type === "text" && typeof c.text === "string") return c.text;
        return "";
      })
      .join("\n");
  }
  return "";
}

function extractLocaleFromStrictContext(text = "") {
  const m = text.match(/LOCALE:\s*([a-zA-Z-]{2,8})/);
  if (!m) return "";
  return normalizeLocale(m[1]);
}

function inferLocaleFromFirstUser(history, fallbackText, explicitLocale) {
  const ex = normalizeLocale(explicitLocale);
  if (ex) return ex;

  if (Array.isArray(history) && history.length) {
    // If previous STRICT_CONTEXT already carried LOCALE, lock to it
    for (const msg of history) {
      if (!msg || msg.role !== "user") continue;
      const t = extractTextFromContent(msg.content);
      const strict = extractLocaleFromStrictContext(t);
      if (strict) return strict;
    }

    // Otherwise detect from earliest user message
    for (const msg of history) {
      if (!msg || msg.role !== "user") continue;
      const t = extractTextFromContent(msg.content);
      if (t && t.trim().length) return detectByScript(t);
    }
  }

  return detectByScript(fallbackText || "");
}

// =====================
// Audio
// =====================
async function transcribeAudio(audioBase64) {
  const clean = cleanBase64(audioBase64);
  // منع “ملفات فاضية” تسبب ردود روبوتية
  if (!clean || clean.length < 200) return "";

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(clean, "base64"));

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt:
        "Automotive diagnostic audio: knocking, squealing, ticking, rattling, misfire, bearing noise, belt noise.",
    });

    return result.text || "";
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return "";
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// =====================
// Main
// =====================
export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text = body.text || "";
    const user_location = body.user_location || "Global";

    // accept both keys
    const image_base_64 = body.image_base_64 || body.image_base64 || "";
    const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
    const history = Array.isArray(body.history) ? body.history : [];

    // 1) transcribe audio (if any)
    const voiceText = await transcribeAudio(audio_base_64);
    const fullInput = `${text} ${voiceText}`.trim();

    // 2) ✅ LANGUAGE LOCK (server-side)
    const locale_locked = inferLocaleFromFirstUser(history, fullInput, body.locale);

    // 3) Local verified search from /data
    const searchPack = await performSearch(fullInput, user_location);
    const VERIFIED_DATA = searchPack.verified_data || [];
    const VERIFIED_WORKSHOPS = searchPack.verified_workshops || [];

    // 4) Build user message content
    const messageContent = [];

    // ✅ IMPORTANT: do NOT include workshops key at all if empty
    const workshopsLine = VERIFIED_WORKSHOPS.length
      ? `\nVERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}`
      : "";

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale_locked}
LOCATION: ${user_location}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}${workshopsLine}

USER_INPUT: ${fullInput}`,
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text: "Image task: identify the car part or fault evidence visible in the photo.",
      });
    }

    // 5) ✅ hard language lock instruction
    const languageLockSystem = {
      role: "system",
      content: [
        `LANGUAGE_LOCK (CRITICAL):`,
        `- The conversation language is permanently locked to: "${locale_locked}".`,
        `- You MUST answer ONLY in "${locale_locked}" for every response.`,
        `- NEVER switch language even if user mixes languages, unless user explicitly asks: "change language to X".`,
      ].join("\n"),
    };

    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        languageLockSystem,
        ...history.slice(-6),
        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    const out = response.choices?.[0]?.message?.content || "";
    return { ok: true, reply: out, locale: locale_locked, locale_locked, voiceText };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);
    return { ok: false, reply: "System is under load. Please try again.", locale: "en" };
    
  }
}
