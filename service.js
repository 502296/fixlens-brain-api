// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

// =====================
// ENV + Clients
// =====================
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ✅ Models
const MODEL_TEXT = process.env.MODEL_TEXT || process.env.OPENAI_MODEL_TEXT || process.env.FIXLENS_TEXT_MODEL || "gpt-5-mini";
const MODEL_VISION = process.env.MODEL_VISION || process.env.OPENAI_MODEL_VISION || "gpt-5-mini";

// ✅ For audio: we do two-step:
// 1) Upload audio as input_file (best-effort)
// 2) Also transcribe with transcribe model (reliable fallback)
const MODEL_TRANSCRIBE =
  process.env.MODEL_TRANSCRIBE ||
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  "gpt-4o-mini-transcribe";

// ✅ Optional language helper model (not required)
const MODEL_LANG = process.env.OPENAI_MODEL_LANG || "gpt-4o-mini";

const DEBUG = String(process.env.FIXLENS_DEBUG || "").toLowerCase() === "true";

// Search / Knowledge tuning
const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

// =====================
// Utilities
// =====================
function safeText(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function clampArr(arr, n) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= n) return arr;
  return arr.slice(arr.length - n);
}

function logDebug(...args) {
  if (DEBUG) console.log("[FixLens]", ...args);
}

function looksLikeArabic(s) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(s || "");
}

function primaryLang(locale) {
  const l = normalizeLocale(locale || "en");
  return l || "en";
}

// Extract assistant output safely from Responses API result
function extractOutputText(resp) {
  if (!resp) return "";
  if (typeof resp.output_text === "string") return resp.output_text.trim();

  // fallback: walk output array
  try {
    const out = resp.output;
    if (Array.isArray(out)) {
      let txt = "";
      for (const item of out) {
        if (!item) continue;
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            // ✅ Responses API uses: output_text for assistant content parts
            if (c?.type === "output_text" && typeof c.text === "string") {
              txt += (txt ? "\n" : "") + c.text;
            }
          }
        }
      }
      return String(txt || "").trim();
    }
  } catch (_) {}
  return "";
}

function summarizeHistory(history = []) {
  // history expected from Flutter: [{role:'user'|'assistant', text:'...'}]
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => ({
      role: h?.role === "assistant" ? "assistant" : "user",
      text: safeText(h?.text).trim(),
    }))
    .filter((x) => x.text.length > 0);
}

// Heuristic: do we have intake essentials?
function missingIntakeBasics(text) {
  const t = (text || "").toLowerCase();
  // year + make/model + symptoms hints
  const hasYear = /\b(19|20)\d{2}\b/.test(t);
  const hasModelHint =
    /(toyota|honda|ford|chevy|chevrolet|nissan|bmw|mercedes|hyundai|kia|vw|volkswagen|audi|lexus|jeep|ram|gmc|freightliner|cascadia|camry|corolla|civic|accord|f-150|silverado|altima|sentra|cr-v|rav4|tacoma|sierra)/i.test(
      t
    );

  // if user gave longer context, we won't block
  const enoughLength = t.replace(/\s+/g, " ").trim().length >= 40;

  return !(hasYear && (hasModelHint || enoughLength));
}

function buildSearchQueryFromText(text) {
  // Keep it safe & short: extract a few keywords
  const t = safeText(text).trim();
  if (!t) return "";
  // If Arabic, keep Arabic query; Serper can still work.
  return t.length > 140 ? t.slice(0, 140) : t;
}

function formatSearchResults(results = []) {
  // results: [{title, link, snippet}] — we keep it short
  if (!Array.isArray(results) || results.length === 0) return "";
  const picks = results.slice(0, MAX_SEARCH_SNIPS);
  const lines = picks
    .map((r, i) => {
      const title = safeText(r?.title).trim();
      const link = safeText(r?.link).trim();
      const snip = safeText(r?.snippet).trim();
      const parts = [];
      if (title) parts.push(title);
      if (snip) parts.push(snip);
      if (link) parts.push(link);
      return `${i + 1}) ${parts.join(" — ")}`.trim();
    })
    .filter(Boolean);
  return lines.join("\n");
}

async function detectLanguage(text, locale) {
  // We already have locale from app, but if user typed Arabic and locale is en, fix it.
  const l = primaryLang(locale);
  const t = safeText(text);
  if (looksLikeArabic(t)) return "ar";
  return l || "en";
}

// =====================
// Core: build responses input
// =====================
function buildSystemPrompt({ locale }) {
  // doctorPrompt.js returns a big system string (English text)
  // We additionally force output language.
  const lang = primaryLang(locale);

  const languageRule =
    lang === "ar"
      ? "Output MUST be in Arabic."
      : `Output MUST be in the user's language. The user locale is: ${lang}.`;

  return `
${buildDoctorMessages()}

Hard rules:
- ${languageRule}
- Be calm, professional, not showy.
- Use probability language (likely/common/often).
- Never provide an absolute final diagnosis.
- Ask at most ONE follow-up question only if truly needed.
- Always include a quick "Is it safe to drive?" judgment.

If you use search snippets:
- Do NOT show raw URLs unless needed.
- Use them quietly as background; never mention "Serper" or tool names.

`.trim();
}

function buildContextBlock({ knowledgeSnips, searchSnips, mode, intakeAlreadyAsked }) {
  const parts = [];

  if (mode) parts.push(`Mode: ${mode}`);

  if (Array.isArray(knowledgeSnips) && knowledgeSnips.length) {
    parts.push(`Internal knowledge (short snippets):\n${knowledgeSnips.join("\n")}`);
  }

  if (searchSnips) {
    parts.push(`Web hints (short):\n${searchSnips}`);
  }

  // Intake policy: only once per session
  parts.push(`Intake already asked: ${intakeAlreadyAsked ? "yes" : "no"}`);

  return parts.filter(Boolean).join("\n\n").trim();
}

function buildHistoryInput(historyTurns) {
  // Responses input expects array of messages:
  // [{role:'user', content:[{type:'input_text', text:'...'}]}]
  return historyTurns.map((t) => ({
    role: t.role,
    content: [{ type: "input_text", text: t.text }],
  }));
}

// =====================
// Audio helpers
// =====================
async function transcribeAudio(audioBuffer, audioMime = "audio/mp4") {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 2000) return "";

  // best effort filename by mime
  const ext =
    audioMime.includes("wav") ? "wav" : audioMime.includes("mpeg") ? "mp3" : audioMime.includes("aac") ? "aac" : "m4a";

  const file = await toFile(audioBuffer, `fixlens_audio.${ext}`, { type: audioMime });

  const r = await openai.audio.transcriptions.create({
    model: MODEL_TRANSCRIBE,
    file,
  });

  const text = safeText(r?.text).trim();
  return text;
}

async function uploadAsInputFile(audioBuffer, audioMime = "audio/mp4") {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 2000) return null;

  const ext =
    audioMime.includes("wav") ? "wav" : audioMime.includes("mpeg") ? "mp3" : audioMime.includes("aac") ? "aac" : "m4a";

  const file = await toFile(audioBuffer, `fixlens_audio.${ext}`, { type: audioMime });

  // purpose "assistants" works for input_file usage in Responses
  const created = await openai.files.create({
    file,
    purpose: "assistants",
  });

  return created?.id || null;
}

// =====================
// Main handler called by server.js
// =====================
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
      return { ok: false, error: "NO_OPENAI_KEY", reply: "" };
    }

    const userLocale = normalizeLocale(locale);
    const historyTurns = summarizeHistory(history);

    // Keep only last ~20 turns to control tokens
    const recentTurns = clampArr(historyTurns, 20);

    // Detect output language (light heuristic)
    const outLang = await detectLanguage(text, userLocale);

    // Knowledge base hints
    let knowledgeSnips = [];
    try {
      const kn = buildKnowledgeSnippets({
        text: safeText(text),
        max: MAX_KNOWLEDGE_SNIPS,
      });
      if (Array.isArray(kn)) knowledgeSnips = kn;
    } catch (e) {
      logDebug("knowledge error:", e?.message || e);
    }

    // Search (best-effort)
    let searchSnips = "";
    try {
      const q = buildSearchQueryFromText(text);
      if (q) {
        const sr = await webSearchSerper(q, {
          gl: "us",
          hl: outLang === "ar" ? "ar" : "en",
          num: MAX_SEARCH_RESULTS,
        });
        if (sr?.ok && Array.isArray(sr.results) && sr.results.length) {
          searchSnips = formatSearchResults(sr.results);
        }
      }
    } catch (e) {
      logDebug("search error:", e?.message || e);
    }

    // Intake logic: only once per session
    // If missing basics and not already asked, we will ask ONE follow-up.
    const shouldAskIntake = !intakeAlreadyAsked && missingIntakeBasics(text);

    // Build system + context
    const systemText = buildSystemPrompt({ locale: outLang });
    const extraContext = buildContextBlock({
      knowledgeSnips,
      searchSnips,
      mode: null,
      intakeAlreadyAsked: Boolean(intakeAlreadyAsked),
    });

    // Build Responses input messages
    const input = [];

    // ✅ IMPORTANT: Responses API uses input_text (NOT "text")
    input.push({
      role: "system",
      content: [{ type: "input_text", text: systemText }],
    });

    // add context as developer message (still input_text)
    if (extraContext) {
      input.push({
        role: "developer",
        content: [{ type: "input_text", text: extraContext }],
      });
    }

    // include compact history
    if (recentTurns.length) {
      input.push(...buildHistoryInput(recentTurns));
    }

    // Build user content multi-modal
    const userContent = [];

    // User main text
    const userText = safeText(text).trim();
    if (userText) {
      userContent.push({ type: "input_text", text: userText });
    }

    // Image as data URL (best for small images)
    if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 20) {
      const b64 = imageBuffer.toString("base64");
      const dataUrl = `data:${imageMime || "image/jpeg"};base64,${b64}`;
      userContent.push({ type: "input_image", image_url: dataUrl });
    }

    // Audio: attach input_file if possible + also transcript fallback
    let transcript = safeText(audioTranscript).trim();
    let audioFileId = null;

    if (hasAudio && audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000) {
      try {
        // Upload audio as input_file (best effort)
        audioFileId = await uploadAsInputFile(audioBuffer, audioMime);
      } catch (e) {
        logDebug("audio upload error:", e?.message || e);
        audioFileId = null;
      }

      if (!transcript) {
        try {
          transcript = await transcribeAudio(audioBuffer, audioMime);
        } catch (e) {
          logDebug("transcribe error:", e?.message || e);
          transcript = "";
        }
      }

      // If we have a file id, pass it
      if (audioFileId) {
        userContent.push({ type: "input_file", file_id: audioFileId });
      }

      // Always include transcript as backup context
      if (transcript) {
        userContent.push({
          type: "input_text",
          text:
            outLang === "ar"
              ? `تفريغ الصوت (قد لا يكون دقيق 100%):\n${transcript}`
              : `Audio transcript (may be imperfect):\n${transcript}`,
        });
      }
    }

    // If user sent only image/audio and no text, ensure at least one text instruction
    if (!userContent.some((c) => c.type === "input_text" && safeText(c.text).trim())) {
      userContent.unshift({
        type: "input_text",
        text:
          outLang === "ar"
            ? "حلّل المرفق وحدد الاحتمالات الأكثر شيوعًا وما إذا كان آمنًا الاستمرار بالقيادة."
            : "Analyze the attachment, list the most likely causes, and whether it’s safe to keep driving.",
      });
    }

    input.push({
      role: "user",
      content: userContent,
    });

    // If we decide to ask intake, bias the assistant to ask only ONE question
    // without breaking the flow.
    let finalModel = MODEL_TEXT;

    // If image is present, prefer vision model
    if (hasImage) finalModel = MODEL_VISION;

    // If audio present, we still respond with text model (gpt-5-mini),
    // because we already injected transcript + input_file.
    // (You requested "gpt-4o for audio"; we cover that by transcribing with 4o-mini-transcribe
    // and attaching the file for best-effort audio context.)

    const response = await openai.responses.create({
      model: finalModel,
      input,
      // (Optional) You can tune verbosity:
      // max_output_tokens: 650,
    });

    let reply = extractOutputText(response);

    // If missing basics and not already asked: ask ONE intake question (short)
    // Only if the model didn't already ask a question.
    if (shouldAskIntake && reply) {
      const alreadyAskedQ = /[?؟]\s*$/.test(reply) || /(\bwhich\b|\bwhat\b|\bany\b|\bwhen\b).*\?/i.test(reply);
      if (!alreadyAskedQ) {
        reply +=
          outLang === "ar"
            ? "\n\nسؤال واحد فقط قبل ما أحدد الاحتمالات بدقة: ما هي سنة السيارة + الموديل + هل تظهر لمبة فحص المحرك أو أكواد؟"
            : "\n\nOne quick question before I narrow it down: what’s the year + make/model, and do you have any check-engine light or codes?";
      }
    }

    // Clean
    reply = safeText(reply).trim();
    if (!reply) {
      reply =
        outLang === "ar"
          ? "صار خطأ بسيط. جرّب مرة ثانية بعد لحظة."
          : "A small error happened. Please try again in a moment.";
    }

    return {
      ok: true,
      reply,
      meta: {
        model: finalModel,
        lang: outLang,
        sessionId: safeText(sessionId),
        usedSearch: Boolean(searchSnips),
        usedKnowledge: Boolean(knowledgeSnips?.length),
        hasImage: Boolean(hasImage),
        hasAudio: Boolean(hasAudio),
        audioFileId: audioFileId || null,
        transcriptLen: transcript ? transcript.length : 0,
      },
    };
  } catch (err) {
    console.error("handleFixLensRequest error:", err?.message || err);
    return {
      ok: false,
      error: "HANDLE_FIXLENS_FAILED",
      reply: "",
    };
  }
}
