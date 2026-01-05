// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

// -------------------------
// OpenAI client
// -------------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// -------------------------
// Models (your requirement)
// -------------------------
// TEXT: gpt-5-mini
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || process.env.MODEL_TEXT || "gpt-5-mini";

// VISION: keep configurable (default = gpt-5-mini)
const MODEL_VISION = process.env.OPENAI_MODEL_VISION || process.env.MODEL_VISION || "gpt-5-mini";

// AUDIO: analyze with gpt-4o (your requirement)
const MODEL_AUDIO = process.env.OPENAI_MODEL_AUDIO || "gpt-4o";

// TRANSCRIBE: stable
const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  process.env.MODEL_TRANSCRIBE ||
  "gpt-4o-mini-transcribe";

// -------------------------
// Search / Knowledge tuning
// -------------------------
const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

const FIXLENS_DEBUG = String(process.env.FIXLENS_DEBUG || "").toLowerCase() === "true";

function safeText(x) {
  return typeof x === "string" ? x : "";
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function primaryLang(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function logDebug(...args) {
  if (FIXLENS_DEBUG) console.log("[FixLens DEBUG]", ...args);
}

// -------------------------
// Heuristics: when to search
// -------------------------
function shouldSearch(userText = "") {
  const t = userText.toLowerCase().trim();
  if (!t) return false;

  // obvious web intent
  if (
    t.includes("link") ||
    t.includes("website") ||
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("near me") ||
    t.includes("address") ||
    t.includes("phone") ||
    t.includes("hours") ||
    t.includes("where can i") ||
    t.includes("best") ||
    t.includes("review") ||
    t.includes("تقرير") ||
    t.includes("سعر") ||
    t.includes("كم سعر") ||
    t.includes("وين") ||
    t.includes("اقرب") ||
    t.includes("موقع") ||
    t.includes("رابط")
  ) return true;

  // question patterns
  if (t.includes("?") || t.startsWith("how ") || t.startsWith("what ") || t.startsWith("where ")) return true;

  return false;
}

function formatSearchSnips(results = []) {
  const items = safeArr(results).slice(0, MAX_SEARCH_SNIPS);

  // Keep it model-friendly (no markdown requirement, no huge payload)
  return items
    .map((r, i) => {
      const title = safeText(r.title).trim();
      const link = safeText(r.link).trim();
      const snippet = safeText(r.snippet).trim();
      const line1 = `${i + 1}) ${title || "Result"}`;
      const line2 = link ? `URL: ${link}` : "";
      const line3 = snippet ? `Note: ${snippet}` : "";
      return [line1, line2, line3].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

// -------------------------
// History normalization
// server passes: [{role, text}] or maybe {role, content}
// -------------------------
function normalizeHistory(history = []) {
  const turns = safeArr(history)
    .map((t) => {
      const role = safeText(t?.role).trim() || "user";
      const text = safeText(t?.text || t?.content || "").trim();
      if (!text) return null;
      return { role: role === "assistant" ? "assistant" : "user", text };
    })
    .filter(Boolean);

  // Limit to keep requests small
  const MAX_TURNS = 20;
  return turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
}

// -------------------------
// Knowledge snippets wrapper (robust to signature differences)
// -------------------------
async function getKnowledgeSnips(userText) {
  try {
    // Some versions may be buildKnowledgeSnippets(text, {max}) or (text, max)
    const fn = buildKnowledgeSnippets;

    // attempt common signatures safely
    let out = fn(userText, { max: MAX_KNOWLEDGE_SNIPS });
    if (out && typeof out.then === "function") out = await out;

    if (!out) {
      out = fn(userText, MAX_KNOWLEDGE_SNIPS);
      if (out && typeof out.then === "function") out = await out;
    }

    if (typeof out === "string") return out.trim();
    if (Array.isArray(out)) return out.join("\n").trim();
    if (out && typeof out === "object" && Array.isArray(out.snips)) return out.snips.join("\n").trim();

    return "";
  } catch (e) {
    logDebug("Knowledge error:", e?.message || e);
    return "";
  }
}

// -------------------------
// OpenAI Responses API helper (correct for GPT-5)
// -------------------------
async function runResponses({
  model,
  locale,
  systemText,
  userText,
  historyTurns,
  imageDataUrl = null, // "data:image/jpeg;base64,...."
  extraContext = "",
}) {
  const input = [];

  // System
  input.push({
    role: "system",
    content: [{ type: "text", text: systemText }],
  });

  // Optional: compact history
  if (historyTurns.length) {
    // feed as plain text turns to keep compatibility stable
    const histBlock = historyTurns
      .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.text}`)
      .join("\n");
    input.push({
      role: "system",
      content: [
        {
          type: "text",
          text:
            "Conversation context (most recent turns):\n" +
            histBlock +
            "\n\nFollow the rules and keep continuity.",
        },
      ],
    });
  }

  // Extra context (knowledge + search)
  if (extraContext && extraContext.trim()) {
    input.push({
      role: "system",
      content: [{ type: "text", text: extraContext.trim() }],
    });
  }

  // User (text + optional image)
  const userContent = [];
  if (userText && userText.trim()) {
    userContent.push({ type: "text", text: userText.trim() });
  } else {
    userContent.push({ type: "text", text: "Please analyze the attached media." });
  }

  if (imageDataUrl) {
    userContent.push({
      type: "input_image",
      image_url: imageDataUrl,
    });
  }

  input.push({ role: "user", content: userContent });

  const r = await openai.responses.create({
    model,
    input,
    // A small safety: keep outputs concise; your doctorPrompt controls style anyway
    max_output_tokens: 700,
    metadata: {
      app: "fixlens",
      locale: primaryLang(locale),
      modality: imageDataUrl ? "vision" : "text",
    },
  });

  const text = (r.output_text || "").trim();
  return text;
}

// -------------------------
// Audio transcription helper (real audio)
// -------------------------
async function transcribeAudio(audioBuffer, audioMime = "audio/mp4") {
  // OpenAI Node SDK expects file-like; use toFile
  const ext =
    audioMime.includes("wav") ? "wav" :
    audioMime.includes("mpeg") ? "mp3" :
    audioMime.includes("aac") ? "aac" :
    "m4a";

  const file = await toFile(audioBuffer, `fixlens_audio.${ext}`, { type: audioMime });

  const tr = await openai.audio.transcriptions.create({
    file,
    model: MODEL_TRANSCRIBE,
  });

  const transcript = safeText(tr?.text).trim();
  return transcript;
}

// -------------------------
// Public API: server.js imports this
// -------------------------
export async function handleFixLensRequest({
  text,
  locale = "en",
  history = [],
  sessionId = "",

  hasImage = false,
  imageBuffer = null,
  imageMime = "image/jpeg",

  hasAudio = false,
  audioBuffer = null,
  audioMime = "audio/mp4",

  audioTranscript = "",
  intakeAlreadyAsked = false,
} = {}) {
  try {
    if (!OPENAI_KEY) {
      return { ok: false, error: "NO_OPENAI_KEY", reply: "", meta: { sessionId } };
    }

    const lang = primaryLang(locale);
    const userText = safeText(text).trim();

    const historyTurns = normalizeHistory(history);

    // Doctor system prompt (your doctorPrompt.js)
    const doctorRules = safeText(buildDoctorMessages()).trim();

    // Base system message (keep code english; reply in user language)
    const systemText =
      `${doctorRules}\n\n` +
      `Context:\n` +
      `- locale: ${lang}\n` +
      `- sessionId: ${safeText(sessionId)}\n` +
      `- intakeAlreadyAsked: ${Boolean(intakeAlreadyAsked)}\n` +
      `Always reply in the user's language (locale).\n`;

    // Knowledge snippets (from local autoKnowledge)
    const knowledge = await getKnowledgeSnips(userText);
    const knowledgeBlock = knowledge
      ? `Internal knowledge (use if relevant):\n${knowledge}\n`
      : "";

    // Search (Serper)
    let searchBlock = "";
    if (shouldSearch(userText)) {
      try {
        const s = await webSearchSerper(userText, { gl: "us", hl: "en", num: MAX_SEARCH_RESULTS });
        if (s?.ok && Array.isArray(s.results) && s.results.length) {
          const sn = formatSearchSnips(s.results);
          if (sn) {
            searchBlock =
              `Web search results (use if helpful; do NOT apologize; if you cite a source, mention its title):\n` +
              `${sn}\n`;
          }
        }
      } catch (e) {
        logDebug("Search error:", e?.message || e);
        // Don't fail the whole request if search fails.
      }
    }

    // Image data URL if present
    let imageDataUrl = null;
    if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 1000) {
      const b64 = imageBuffer.toString("base64");
      imageDataUrl = `data:${imageMime || "image/jpeg"};base64,${b64}`;
    }

    // Audio: real pipeline (transcribe then analyze with MODEL_AUDIO=gpt-4o)
    let finalUserText = userText;
    let transcript = safeText(audioTranscript).trim();

    if (hasAudio && audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000) {
      if (!transcript) {
        transcript = await transcribeAudio(audioBuffer, audioMime);
      }

      // If still empty transcript, keep a safe fallback
      if (!transcript) {
        transcript = "Unclear/empty transcript.";
      }

      // Attach transcript into prompt as the user's message context
      // (Do NOT expose tool details; just treat it as what the user said/heard)
      finalUserText =
        (userText ? `${userText}\n\n` : "") +
        `Audio transcript:\n${transcript}\n\n` +
        `Important: This is a vehicle/engine/drivetrain noise recording, not a speaker/radio issue.`;

      const extraContext = [knowledgeBlock, searchBlock].filter(Boolean).join("\n");

      const reply = await runResponses({
        model: MODEL_AUDIO,            // ✅ gpt-4o for audio analysis (your requirement)
        locale: lang,
        systemText,
        userText: finalUserText,
        historyTurns,
        imageDataUrl: null,
        extraContext,
      });

      return {
        ok: true,
        reply: reply || "No reply.",
        meta: {
          sessionId,
          locale: lang,
          usedModel: MODEL_AUDIO,
          usedTranscribe: MODEL_TRANSCRIBE,
          hasAudio: true,
          hasImage: false,
        },
      };
    }

    // Vision: if image present, use MODEL_VISION (default gpt-5-mini)
    if (imageDataUrl) {
      const extraContext = [knowledgeBlock, searchBlock].filter(Boolean).join("\n");

      const reply = await runResponses({
        model: MODEL_VISION,
        locale: lang,
        systemText,
        userText: finalUserText,
        historyTurns,
        imageDataUrl,
        extraContext,
      });

      return {
        ok: true,
        reply: reply || "No reply.",
        meta: {
          sessionId,
          locale: lang,
          usedModel: MODEL_VISION,
          hasAudio: false,
          hasImage: true,
        },
      };
    }

    // Text-only: use MODEL_TEXT (gpt-5-mini) via Responses API (correct)
    {
      const extraContext = [knowledgeBlock, searchBlock].filter(Boolean).join("\n");

      const reply = await runResponses({
        model: MODEL_TEXT,             // ✅ gpt-5-mini
        locale: lang,
        systemText,
        userText: finalUserText,
        historyTurns,
        imageDataUrl: null,
        extraContext,
      });

      return {
        ok: true,
        reply: reply || "No reply.",
        meta: {
          sessionId,
          locale: lang,
          usedModel: MODEL_TEXT,
          hasAudio: false,
          hasImage: false,
        },
      };
    }
  } catch (err) {
    // IMPORTANT: return real error in meta for debugging (server.js can still hide it)
    console.error("handleFixLensRequest error:", err?.message || err);

    return {
      ok: false,
      error: "OPENAI_REQUEST_FAILED",
      reply: "",
      meta: {
        message: safeText(err?.message),
        name: safeText(err?.name),
      },
    };
  }
}
