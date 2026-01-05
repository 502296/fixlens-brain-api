// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";

const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  "";

if (!OPENAI_KEY) {
  throw new Error("OPENAI_API_KEY is missing");
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ============================================================
   MODELS (Railway-compatible)
============================================================ */
const MODEL_TEXT =
  process.env.OPENAI_MODEL_TEXT ||
  process.env.MODEL_TEXT ||
  "gpt-5-mini";

const MODEL_VISION =
  process.env.OPENAI_MODEL_VISION ||
  process.env.MODEL_VISION ||
  "gpt-4o";

const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  process.env.MODEL_TRANSCRIBE ||
  "gpt-4o-mini-transcribe";

/* ============================================================
   LIMITS
============================================================ */
const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

/* ============================================================
   HELPERS
============================================================ */
function safeText(s) {
  return String(s || "").trim();
}

/* ============================================================
   MAIN ENTRY
============================================================ */
export async function handleFixLensRequest({
  text,
  locale,
  history = [],
  sessionId,

  hasImage,
  imageBuffer,
  imageMime,

  hasAudio,
  audioBuffer,
  audioMime,

  audioTranscript = "",
  intakeAlreadyAsked = false,
}) {
  try {
    /* ------------------------------------------------------------
       1) TRANSCRIBE AUDIO (if exists)
    ------------------------------------------------------------ */
    let finalUserText = safeText(text);

    if (hasAudio && audioBuffer) {
      const transcription = await openai.audio.transcriptions.create({
        file: new File([audioBuffer], "audio", { type: audioMime }),
        model: MODEL_TRANSCRIBE,
      });

      finalUserText =
        safeText(transcription.text) ||
        "Analyze the attached engine/vehicle sound. This is not a speaker or radio issue.";
    }

    /* ------------------------------------------------------------
       2) SEARCH (optional, controlled)
    ------------------------------------------------------------ */
    let searchSnips = [];
    try {
      const search = await webSearchSerper(finalUserText, {
        num: MAX_SEARCH_RESULTS,
      });
      if (search?.results?.length) {
        searchSnips = search.results
          .slice(0, MAX_SEARCH_SNIPS)
          .map((r) => `• ${r.title}: ${r.snippet}`);
      }
    } catch (_) {
      // search is optional – ignore errors
    }

    /* ------------------------------------------------------------
       3) KNOWLEDGE BASE
    ------------------------------------------------------------ */
    const knowledgeSnips = buildKnowledgeSnippets(
      finalUserText,
      MAX_KNOWLEDGE_SNIPS
    );

    /* ------------------------------------------------------------
       4) BUILD PROMPT (Doctor Logic)
    ------------------------------------------------------------ */
    const doctorMessages = buildDoctorMessages({
      locale,
      intakeAlreadyAsked,
      knowledgeSnips,
      searchSnips,
    });

    /* ------------------------------------------------------------
       5) BUILD INPUT FOR GPT-5 (responses API)
    ------------------------------------------------------------ */
    const input = [
      {
        role: "system",
        content: doctorMessages,
      },
      ...history.map((h) => ({
        role: h.role,
        content: h.text,
      })),
      {
        role: "user",
        content: finalUserText,
      },
    ];

    if (hasImage && imageBuffer) {
      input.push({
        role: "user",
        content: [
          { type: "input_text", text: finalUserText },
          {
            type: "input_image",
            image_base64: imageBuffer.toString("base64"),
            mime_type: imageMime,
          },
        ],
      });
    }

    /* ------------------------------------------------------------
       6) OPENAI CALL (THE FIX 🔥)
    ------------------------------------------------------------ */
    const response = await openai.responses.create({
      model: MODEL_TEXT,
      input,
    });

    const output =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "";

    return {
      ok: true,
      reply: safeText(output),
      meta: {
        model_text: MODEL_TEXT,
        model_vision: MODEL_VISION,
        model_transcribe: MODEL_TRANSCRIBE,
      },
    };
  } catch (err) {
    console.error("FixLens error:", err);
    return {
      ok: false,
      error: err.message || "FIXLENS_ERROR",
    };
  }
}
