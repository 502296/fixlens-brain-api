// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language (handled by doctorPrompt).

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

// -----------------------------
// ENV
// -----------------------------
const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI_API_TOKEN ||
  "";

const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Models
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT ||
  process.env.FIXLENS_TEXT_MODEL ||
  process.env.MODEL_TEXT ||
  "gpt-5-mini";

const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION ||
  process.env.MODEL_VISION ||
  MODEL_TEXT;

const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  process.env.MODEL_TRANSCRIBE ||
  "gpt-4o-mini-transcribe";

// Limits
const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

const FIXLENS_DEBUG = String(process.env.FIXLENS_DEBUG || "").toLowerCase() === "true";

// -----------------------------
// Helpers
// -----------------------------
function safeText(x) {
  return typeof x === "string" ? x.trim() : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function isBase64Data(x) {
  return typeof x === "string" && x.length > 50 && /^[A-Za-z0-9+/=\s]+$/.test(x.slice(0, 200));
}

function base64ToBuffer(b64) {
  const cleaned = String(b64 || "").replace(/^data:.*;base64,/, "").trim();
  return Buffer.from(cleaned, "base64");
}

function guessImageMime(b64OrDataUrl) {
  const s = String(b64OrDataUrl || "");
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  if (m?.[1]) return m[1];
  // fallback: jpeg
  return "image/jpeg";
}

function guessAudioMime(mimeFromClient, b64OrDataUrl) {
  const s = String(b64OrDataUrl || "");
  const m = s.match(/^data:(audio\/[a-zA-Z0-9.+-]+);base64,/);
  return mimeFromClient || (m?.[1] || "audio/m4a");
}

function shouldUseSearch(userText) {
  const t = userText.toLowerCase();

  // Search triggers: shops near me, prices, where to buy, recall, TSB, part numbers, etc.
  const patterns = [
    "near me",
    "close to",
    "closest",
    "zip",
    "louisville",
    "kentucky",
    "phone number",
    "address",
    "open now",
    "price",
    "cost",
    "how much",
    "buy",
    "part number",
    "tsb",
    "recall",
    "service bulletin",
    "spec",
    "torque",
    "manual",
    "where can i",
    "أفضل ورشة",
    "ورشة قريبة",
    "اقرب ورشة",
    "سعر",
    "تكلفة",
    "كم سعر",
    "وين القى",
    "وين احصل",
  ];

  return patterns.some((p) => t.includes(p));
}

function pickSnippets(searchResults = []) {
  const out = [];
  for (const r of searchResults.slice(0, MAX_SEARCH_RESULTS)) {
    const title = safeText(r?.title);
    const link = safeText(r?.link);
    const snippet = safeText(r?.snippet || r?.description || "");
    if (title || snippet) out.push({ title, link, snippet });
  }
  return out.slice(0, MAX_SEARCH_SNIPS);
}

function safeLog(...args) {
  if (FIXLENS_DEBUG) console.log(...args);
}

// -----------------------------
// Audio transcription
// -----------------------------
async function transcribeAudio({ audioBase64, audioMime, locale }) {
  if (!audioBase64 || !isBase64Data(audioBase64)) return "";

  const buf = base64ToBuffer(audioBase64);
  if (!buf?.length) return "";

  const ext = (audioMime || "audio/m4a").split("/")[1] || "m4a";
  const file = await toFile(buf, `fixlens_audio.${ext}`);

  // Transcribe (simple + robust)
  // NOTE: Some accounts/models ignore language, but it's okay.
  const r = await openai.audio.transcriptions.create({
    model: MODEL_TRANSCRIBE,
    file,
    // language: normalizeLocale(locale), // optional
  });

  const text = safeText(r?.text);
  return text;
}

// -----------------------------
// Build OpenAI input (Responses API)
// -----------------------------
function buildUserContent({ userText, imageBase64 }) {
  const content = [];

  if (userText) {
    content.push({ type: "input_text", text: userText });
  }

  if (imageBase64 && isBase64Data(imageBase64)) {
    const mime = guessImageMime(imageBase64);
    const data = String(imageBase64).startsWith("data:")
      ? imageBase64
      : `data:${mime};base64,${String(imageBase64).trim()}`;

    content.push({
      type: "input_image",
      image_url: data,
    });
  }

  return content;
}

function buildHistoryMessages(history = []) {
  // history expected array of { role: "user"|"assistant", content: string }
  // Keep it robust.
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const text = safeText(m?.content || m?.text || "");
    if (!text) continue;

    out.push({
      role,
      content: [{ type: "input_text", text }],
    });
  }
  return out;
}

// -----------------------------
// Core
// -----------------------------
async function processRequest(payload = {}) {
  const locale = normalizeLocale(payload.locale || payload.language || "en");
  const userTextRaw = safeText(payload.message || payload.text || "");
  const history = payload.history || payload.messages || [];

  const imageBase64 = payload.imageBase64 || payload.image || payload.photoBase64 || "";
  const audioBase64 = payload.audioBase64 || payload.audio || "";
  const audioMime = guessAudioMime(payload.audioMimeType, audioBase64);

  if (!OPENAI_KEY) {
    return {
      ok: false,
      error: "NO_OPENAI_API_KEY",
      reply: locale === "ar" ? "مفتاح OpenAI غير موجود على السيرفر." : "OpenAI API key is missing on the server.",
      language: locale,
    };
  }

  // 1) Transcribe audio if present
  let audioText = "";
  try {
    if (audioBase64) {
      audioText = await transcribeAudio({ audioBase64, audioMime, locale });
      safeLog("Audio transcription:", audioText);
    }
  } catch (e) {
    console.warn("Audio transcribe failed (continuing):", e?.message || e);
  }

  // Merge userText + audioText
  const combinedUserText = [userTextRaw, audioText ? `Voice note: ${audioText}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combinedUserText && !imageBase64) {
    return {
      ok: false,
      error: "EMPTY_INPUT",
      reply: locale === "ar" ? "اكتب المشكلة أو أرسل صورة/صوت." : "Please type the issue or attach an image/audio.",
      language: locale,
    };
  }

  // 2) Knowledge snippets (local)
  let knowledge = "";
  try {
    knowledge = await buildKnowledgeSnippets(combinedUserText, {
      maxSnips: MAX_KNOWLEDGE_SNIPS,
      locale,
    });
  } catch (e) {
    console.warn("Knowledge build failed (continuing):", e?.message || e);
  }

  // 3) Optional web search
  let searchBlock = "";
  try {
    if (shouldUseSearch(combinedUserText)) {
      const s = await webSearchSerper(combinedUserText, {
        gl: "us",
        hl: "en",
        num: MAX_SEARCH_RESULTS,
      });

      const results = s?.results || [];
      const picked = pickSnippets(results);

      if (picked.length) {
        searchBlock =
          `\n\nWeb context (for references only):\n` +
          picked
            .map(
              (x, i) =>
                `${i + 1}) ${x.title || "Result"}\n${x.snippet || ""}\n${x.link || ""}`.trim()
            )
            .join("\n\n");
      }
    }
  } catch (e) {
    console.warn("Search failed (continuing):", e?.message || e);
  }

  // 4) Build doctor messages (system/user shaping)
  // buildDoctorMessages should return a string "system prompt"
  const doctorSystem = buildDoctorMessages();

  // We pass the combined info into the user text
  const enrichedUserText =
    combinedUserText +
    (knowledge ? `\n\nLocal knowledge:\n${knowledge}` : "") +
    (searchBlock ? `\n${searchBlock}` : "");

  // 5) Build full conversation for Responses API
  const msgs = [
    { role: "system", content: [{ type: "input_text", text: doctorSystem }] },
    ...buildHistoryMessages(history),
    {
      role: "user",
      content: buildUserContent({ userText: enrichedUserText, imageBase64 }),
    },
  ];

  // 6) Call OpenAI (robust)
  let ai;
  try {
    ai = await openai.responses.create({
      model: imageBase64 ? MODEL_VISION : MODEL_TEXT,
      input: msgs,
      // Keep it calm, practical. Avoid long essays.
      max_output_tokens: 600,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("OpenAI call failed:", msg);
    return {
      ok: false,
      error: "OPENAI_CALL_FAILED",
      reply:
        locale === "ar"
          ? "صار خطأ أثناء التحليل. جرّب مرة ثانية بعد لحظة."
          : "Something went wrong while analyzing. Please try again in a moment.",
      language: locale,
    };
  }

  // Guard against undefined / missing shape
  if (!ai || typeof ai !== "object") {
    return {
      ok: false,
      error: "AI_RESPONSE_UNDEFINED",
      reply:
        locale === "ar"
          ? "صار خطأ أثناء التحليل. جرّب مرة ثانية بعد لحظة."
          : "Something went wrong while analyzing. Please try again in a moment.",
      language: locale,
    };
  }

  // Some responses have status, some don't. Never crash.
  const status = safeText(ai.status);
  if (status && status !== "completed") {
    safeLog("AI status:", status);
    // Still try to extract text if any
  }

  // Extract output text robustly
  let reply = "";
  try {
    // SDK helper (works on most)
    if (typeof ai.output_text === "string") reply = ai.output_text;

    // fallback parsing
    if (!reply && Array.isArray(ai.output)) {
      for (const item of ai.output) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const c of content) {
          // Could be output_text
          if (c?.type === "output_text" && typeof c?.text === "string") {
            reply += c.text;
          }
        }
      }
    }

    reply = safeText(reply);
  } catch (e) {
    console.warn("Reply parse failed:", e?.message || e);
  }

  if (!reply) {
    return {
      ok: false,
      error: "EMPTY_AI_REPLY",
      reply:
        locale === "ar"
          ? "استلمت رد فارغ. جرّب مرة ثانية."
          : "I received an empty response. Please try again.",
      language: locale,
    };
  }

  return { ok: true, reply, language: locale };
}

// -----------------------------
// Express handler
// -----------------------------
export async function handleFixLensRequest(req, res) {
  try {
    const payload = req.body || {};
    const result = await processRequest(payload);

    // Always respond JSON, never crash the server.
    res.status(result.ok ? 200 : 200).json(result);
  } catch (e) {
    console.error("processRequest fatal:", e?.message || e);
    res.status(200).json({
      ok: false,
      error: "FATAL",
      reply: "Something went wrong while analyzing. Please try again in a moment.",
      language: "en",
    });
  }
}
