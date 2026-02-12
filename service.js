// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// =====================
// Audio
// =====================
async function transcribeAudio(audioBase64) {
  if (!audioBase64 || audioBase64.length < 50) return "";
  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
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
// Language Detection Helpers
// =====================
function detectByScript(text = "") {
  // Arabic
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  // Basic fallback
  return "en";
}

function normalizeLocale(loc) {
  if (!loc) return "";
  const s = String(loc).trim().toLowerCase();
  // normalize common cases
  if (s.startsWith("ar")) return "ar";
  if (s.startsWith("en")) return "en";
  if (s.startsWith("es")) return "es";
  if (s.startsWith("fr")) return "fr";
  if (s.startsWith("de")) return "de";
  if (s.startsWith("it")) return "it";
  // keep short unknown locale as-is (e.g., "pt", "tr")
  return s.length <= 5 ? s : "";
}

// Extract text from history messages (supports string or array content)
function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // content blocks
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

// Try to find LOCALE: xx previously embedded in STRICT_CONTEXT
function extractLocaleFromStrictContext(text = "") {
  const m = text.match(/LOCALE:\s*([a-zA-Z-]{2,8})/);
  if (!m) return "";
  return normalizeLocale(m[1]);
}

function inferLocaleFromFirstUser(history, fallbackText, explicitLocale) {
  // 0) explicit locale from client wins (if provided)
  const ex = normalizeLocale(explicitLocale);
  if (ex) return ex;

  // 1) If history contains STRICT_CONTEXT LOCALE lines, use that (lock)
  if (Array.isArray(history) && history.length) {
    for (const msg of history) {
      if (!msg || msg.role !== "user") continue;
      const t = extractTextFromContent(msg.content);
      const strict = extractLocaleFromStrictContext(t);
      if (strict) return strict;
    }

    // 2) Otherwise detect from the earliest user message text
    for (const msg of history) {
      if (!msg || msg.role !== "user") continue;
      const t = extractTextFromContent(msg.content);
      if (t && t.trim().length) return detectByScript(t);
    }
  }

  // 3) Fallback to current input
  return detectByScript(fallbackText || "");
}

// =====================
// Main Handler
// =====================
export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text = body.text || "";
    const user_location = body.user_location || "Global";

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

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale_locked}
LOCATION: ${user_location}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

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

    // 5) ✅ Inject server-side language lock instruction (cannot be overridden)
    const languageLockSystem = {
      role: "system",
      content: [
        `LANGUAGE_LOCK (CRITICAL):`,
        `- The conversation language is permanently locked to: "${locale_locked}".`,
        `- You MUST answer ONLY in "${locale_locked}" for every response.`,
        `- NEVER switch language even if user mixes languages, unless user explicitly asks: "change language to X".`,
        `- Keep the same language in tone, grammar, and terminology.`,
      ].join("\n"),
    };

    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        languageLockSystem,

        // keep last turns for continuity, but not too many
        ...history.slice(-6),

        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    const out = response.choices?.[0]?.message?.content || "";
    return { ok: true, reply: out, locale: locale_locked, locale_locked };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);
    return { ok: false, reply: "System is under load. Please try again.", locale: "en" };
  }
}
