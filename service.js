// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

// --- OpenAI client
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// --- Models (support both old & new env var names)
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
  process.env.OPENAI_MODEL_TRANSCRIBE ||
  process.env.MODEL_TRANSCRIBE ||
  "gpt-4o-mini-transcribe";

// --- Tuning
const FIXLENS_DEBUG = String(process.env.FIXLENS_DEBUG || "").toLowerCase() === "true";
const MAX_OUTPUT_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 650);

const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

// ----------------- helpers -----------------
function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function looksLikeBase64(s) {
  return typeof s === "string" && s.length > 50 && /^[A-Za-z0-9+/=\n\r]+$/.test(s);
}

function toDataUrl(base64OrDataUrl, mime = "image/jpeg") {
  if (!base64OrDataUrl) return null;
  const s = String(base64OrDataUrl);
  if (s.startsWith("data:")) return s;
  if (!looksLikeBase64(s)) return null;
  return `data:${mime};base64,${s}`;
}

function isSearchIntent(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("near me") ||
    t.includes("close to") ||
    t.includes("nearby") ||
    t.includes("mechanic") ||
    t.includes("shop") ||
    t.includes("garage") ||
    t.includes("zip") ||
    t.includes("40218") ||
    t.includes("louisville") ||
    // Arabic hints
    t.includes("قريب") ||
    t.includes("قريبة") ||
    t.includes("اقرب") ||
    t.includes("ورشة") ||
    t.includes("ميكانيك") ||
    t.includes("كراج")
  );
}

function compactSearchResults(results = []) {
  // return small snippets only (no long walls of text)
  const top = results.slice(0, MAX_SEARCH_SNIPS);
  return top
    .map((r, i) => {
      const title = safeStr(r.title).slice(0, 120);
      const link = safeStr(r.link);
      const snippet = safeStr(r.snippet).slice(0, 180);
      return `${i + 1}) ${title}${link ? ` — ${link}` : ""}${snippet ? ` — ${snippet}` : ""}`;
    })
    .join("\n");
}

function asInputText(text) {
  return { type: "input_text", text: safeStr(text) };
}

function asInputImage(dataUrl) {
  return { type: "input_image", image_url: dataUrl };
}

function mapHistoryToResponsesInput(history) {
  // history: [{role:'user'|'assistant', content:'...'}]
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const contentText =
      safeStr(m?.content) || safeStr(m?.text) || safeStr(m?.message);
    if (!contentText) continue;
    out.push({
      role,
      content: [asInputText(contentText)],
    });
  }
  return out;
}

async function transcribeIfNeeded({ audioBase64, audioMime, audioFilename }) {
  const b64 = safeStr(audioBase64);
  if (!b64) return { transcript: "" };

  const mime = safeStr(audioMime) || "audio/m4a";
  const filename = safeStr(audioFilename) || "audio.m4a";

  // Convert base64 to File for OpenAI
  const buffer = Buffer.from(b64, "base64");
  const file = await toFile(buffer, filename, { type: mime });

  const tr = await openai.audio.transcriptions.create({
    model: MODEL_TRANSCRIBE,
    file,
  });

  const transcript = safeStr(tr?.text);
  return { transcript };
}

// ----------------- main handler -----------------
export async function handleFixLensRequest(req, res) {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_KEY_MISSING",
        message: "Server is missing OPENAI_API_KEY.",
      });
    }

    const body = req?.body || {};

    // Accept many client payload shapes (defensive)
    const locale = normalizeLocale(body.locale || body.language || body.lang || "en");
    const userText =
      safeStr(body.text) ||
      safeStr(body.message) ||
      safeStr(body.prompt) ||
      safeStr(body.input) ||
      "";

    const history = body.history || body.messages || [];

    // Images can be: single image, images array, imageBase64, etc.
    const imagesRaw = Array.isArray(body.images)
      ? body.images
      : body.image
      ? [body.image]
      : body.imageBase64
      ? [body.imageBase64]
      : [];

    const imageMime =
      safeStr(body.imageMime) ||
      safeStr(body.image_mime) ||
      "image/jpeg";

    const imagesDataUrls = imagesRaw
      .map((x) => toDataUrl(x, imageMime))
      .filter(Boolean);

    // Audio can be: audioBase64, audio, voiceBase64...
    const audioBase64 =
      safeStr(body.audioBase64) ||
      safeStr(body.audio) ||
      safeStr(body.voiceBase64) ||
      "";

    const audioMime =
      safeStr(body.audioMime) ||
      safeStr(body.audio_mime) ||
      "audio/m4a";

    const audioFilename =
      safeStr(body.audioFilename) ||
      safeStr(body.audio_filename) ||
      "audio.m4a";

    if (!userText && imagesDataUrls.length === 0 && !audioBase64) {
      return res.status(400).json({
        ok: false,
        error: "EMPTY_INPUT",
        message: "Provide text, image, or audio.",
      });
    }

    // 1) Knowledge snippets (local)
    const knowledge = buildKnowledgeSnippets({
      text: userText,
      maxSnippets: MAX_KNOWLEDGE_SNIPS,
      locale,
    });

    // 2) Optional web search (Serper) — only when needed
    let searchBlock = "";
    if (isSearchIntent(userText)) {
      try {
        const r = await webSearchSerper(userText, {
          gl: "us",
          hl: locale === "ar" ? "ar" : "en",
          num: MAX_SEARCH_RESULTS,
        });
        if (r?.ok && Array.isArray(r.results) && r.results.length) {
          searchBlock =
            "Web results (use only if helpful):\n" +
            compactSearchResults(r.results);
        }
      } catch (e) {
        // Silent fail; never break the diagnosis experience.
        if (FIXLENS_DEBUG) console.error("Search error:", e?.message || e);
      }
    }

    // 3) Audio transcription (if provided)
    let transcript = "";
    if (audioBase64) {
      try {
        const tr = await transcribeIfNeeded({ audioBase64, audioMime, audioFilename });
        transcript = safeStr(tr.transcript);
      } catch (e) {
        if (FIXLENS_DEBUG) console.error("Transcribe error:", e?.message || e);
        transcript = ""; // don't crash
      }
    }

    // 4) Build system + user content
    const systemPrompt = buildDoctorMessages();

    // Build a compact user bundle (avoid huge walls of text)
    // Also: enforce "one follow-up question max" and avoid long output via system rules.
    const userBundleParts = [];

    if (userText) userBundleParts.push(`User text:\n${userText}`);

    if (transcript) userBundleParts.push(`Audio transcript:\n${transcript}`);

    if (knowledge) userBundleParts.push(`Internal knowledge:\n${knowledge}`);

    if (searchBlock) userBundleParts.push(searchBlock);

    // Add a small instruction to keep output short & continue conversation
    userBundleParts.push(
      "Output rules:\n" +
        "- Reply in the user's language.\n" +
        "- Be practical and concise (avoid long essays).\n" +
        "- Ask at most ONE follow-up question if needed.\n" +
        "- If user asks a new question, answer it directly.\n"
    );

    const combinedUserText = userBundleParts.join("\n\n").trim();

    // 5) Build Responses API input (IMPORTANT: use input_text / input_image)
    const responsesInput = [];

    // system
    responsesInput.push({
      role: "system",
      content: [asInputText(systemPrompt)],
    });

    // history from client (so 2nd/3rd message works)
    responsesInput.push(...mapHistoryToResponsesInput(history));

    // current user message
    const userContent = [asInputText(combinedUserText)];
    for (const durl of imagesDataUrls) {
      userContent.push(asInputImage(durl));
    }

    responsesInput.push({
      role: "user",
      content: userContent,
    });

    // Choose model: if images exist, use vision model else text model
    const modelToUse = imagesDataUrls.length ? MODEL_VISION : MODEL_TEXT;

    const resp = await openai.responses.create({
      model: modelToUse,
      input: responsesInput,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    // Extract text safely
    const replyText =
      safeStr(resp?.output_text) ||
      safeStr(
        resp?.output?.[0]?.content
          ?.map((c) => (c?.type?.includes("text") ? c?.text : ""))
          .join("")
      ) ||
      "";

    if (!replyText) {
      return res.status(502).json({
        ok: false,
        error: "EMPTY_MODEL_REPLY",
        message: "Model returned no text.",
      });
    }

    return res.json({
      ok: true,
      reply: replyText,
      language: locale,
      used_model: modelToUse,
      debug: FIXLENS_DEBUG
        ? {
            hasAudio: Boolean(audioBase64),
            hasImages: imagesDataUrls.length,
            hasHistory: Array.isArray(history) && history.length > 0,
          }
        : undefined,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    if (FIXLENS_DEBUG) console.error("handleFixLensRequest error:", msg);

    // Common OpenAI 400 detail exposure (safe)
    return res.status(500).json({
      ok: false,
      error: "SERVER_ERROR",
      message: msg,
    });
  }
}
