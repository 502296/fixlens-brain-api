// service.js — FixLens Brain API (PRO, stable, multimodal + search, English-only code)
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.FIXLENS_MODEL || "gpt-5-mini";
const DEFAULT_VISION_MODEL =
  process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
const DEFAULT_AUDIO_MODEL =
  process.env.FIXLENS_AUDIO_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";

const MAX_COMPLETION_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 700);
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 20);
const SEARCH_NUM_RESULTS = Number(process.env.FIXLENS_SEARCH_NUM || 5);

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function openAIErrorToJSON(err) {
  const status = err?.status || err?.response?.status || err?.error?.status || 500;
  const message = safeStr(err?.message) || safeStr(err?.error?.message) || "Unknown error";
  const code = safeStr(err?.code) || safeStr(err?.error?.code) || "";
  const param = safeStr(err?.param) || safeStr(err?.error?.param) || "";
  const request_id =
    safeStr(err?.request_id) ||
    safeStr(err?.response?.headers?.["x-request-id"]) ||
    safeStr(err?.headers?.["x-request-id"]) ||
    "";
  return { status, message, code, param, request_id };
}

function normalizeHistory(history = []) {
  const arr = Array.isArray(history) ? history : [];
  const last = arr.slice(-MAX_TURNS);

  // Flutter sometimes stores {role, content} or {role, text}
  return last
    .map((m) => {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content =
        typeof m?.content === "string"
          ? m.content
          : typeof m?.text === "string"
          ? m.text
          : "";
      const t = safeStr(content).trim();
      if (!t) return null;
      return { role, content: t };
    })
    .filter(Boolean);
}

/**
 * Search intent detector:
 * - triggers for location/near-me, prices, part numbers, recalls/TSBs, specs,
 *   and "what is" factual web queries.
 * - works across languages without putting non-English strings in code by using
 *   simple heuristics (question marks, currency symbols, URL-like, etc.)
 */
function shouldUseSearch(text) {
  const t = safeStr(text).trim();
  if (!t) return false;

  const lower = t.toLowerCase();

  // Strong English triggers
  const englishTriggers = [
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "shop",
    "garage",
    "mechanic",
    "dealership",
    "phone number",
    "hours",
    "open now",
    "price",
    "cost",
    "how much",
    "part number",
    "oem",
    "tsb",
    "recall",
    "service bulletin",
    "spec",
    "specs",
    "torque spec",
    "fluid capacity",
    "oil capacity",
    "transmission fluid",
    "reset procedure",
    "where to buy",
    "buy",
    "best",
    "compare",
  ];

  if (englishTriggers.some((k) => lower.includes(k))) return true;

  // Language-agnostic signals
  const hasCurrency = /[$€£¥]/.test(t);
  const hasQuestion = /[?？]/.test(t);
  const hasDigitsAndBrandLike = /\b\d{3,}\b/.test(t) && /[a-zA-Z]/.test(t); // typical part codes, model codes
  const looksLikeLookup =
    lower.startsWith("http") ||
    lower.includes(".com") ||
    lower.includes("www.") ||
    lower.includes("google") ||
    lower.includes("wiki");

  // Short factual questions often benefit from search
  const shortQuery = t.length <= 70 && hasQuestion;

  return hasCurrency || hasDigitsAndBrandLike || looksLikeLookup || shortQuery;
}

async function tryWebSearch(query, locale) {
  if (!process.env.SERPER_API_KEY) return [];

  try {
    const hl = locale === "en" ? "en" : locale; // Serper accepts many hl values
    const gl = process.env.FIXLENS_SEARCH_GL || "us";

    const r = await webSearchSerper(query, {
      gl,
      hl,
      num: Math.max(1, Math.min(10, SEARCH_NUM_RESULTS)),
    });

    if (!r?.ok) return [];

    // Keep titles + links + short snippet for doctorPrompt
    return (r.results || [])
      .slice(0, SEARCH_NUM_RESULTS)
      .map((x) => {
        const title = safeStr(x.title);
        const link = safeStr(x.link);
        const snippet = safeStr(x.snippet);
        const line1 = title || "Result";
        const line2 = link ? `Source: ${link}` : "";
        const line3 = snippet ? `Snippet: ${snippet}` : "";
        return [line1, line2, line3].filter(Boolean).join("\n").trim();
      })
      .filter(Boolean);
  } catch (e) {
    console.error("tryWebSearch error:", e?.message || e);
    return [];
  }
}

async function transcribeAudioIfNeeded({ hasAudio, audioBuffer, audioMime, audioTranscript }) {
  const existing = safeStr(audioTranscript).trim();
  if (existing) return existing;
  if (!hasAudio) return "";
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 2000) return "";

  const mime = safeStr(audioMime) || "audio/mp4";
  const ext =
    mime.includes("wav") ? "wav" :
    mime.includes("mp3") ? "mp3" :
    mime.includes("ogg") ? "ogg" :
    mime.includes("webm") ? "webm" :
    mime.includes("m4a") ? "m4a" :
    "mp4";

  const file = await toFile(audioBuffer, `voice.${ext}`);

  const tr = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return safeStr(tr?.text).trim();
}

function bufToDataUrl(buffer, mime = "image/jpeg") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// Robust: try max_completion_tokens first, fallback to max_tokens if needed
async function createChatCompletionWithFallback(req) {
  try {
    return await client.chat.completions.create(req);
  } catch (err) {
    const msg = safeStr(err?.message).toLowerCase();
    const code = safeStr(err?.code);

    const needsSwap =
      msg.includes("max_tokens") ||
      msg.includes("max_completion_tokens") ||
      code === "unsupported_parameter";

    if (!needsSwap) throw err;

    const cloned = { ...req };

    if ("max_tokens" in cloned) {
      cloned.max_completion_tokens = cloned.max_tokens;
      delete cloned.max_tokens;
    } else if ("max_completion_tokens" in cloned) {
      cloned.max_tokens = cloned.max_completion_tokens;
      delete cloned.max_completion_tokens;
    }

    return await client.chat.completions.create(cloned);
  }
}

// Main entry
export async function handleFixLensRequest(payload = {}) {
  const locale = normalizeLocale(payload.locale || payload.language || "en");

  const text = safeStr(payload.text || payload.userText || payload.message || "").trim();

  const hasImage = Boolean(payload.hasImage);
  const imageBuffer = payload.imageBuffer || null;
  const imageMime = safeStr(payload.imageMime) || "image/jpeg";

  const hasAudio = Boolean(payload.hasAudio);
  const audioBuffer = payload.audioBuffer || null;
  const audioMime = safeStr(payload.audioMime) || "audio/mp4";

  const intakeAlreadyAsked = Boolean(payload.intakeAlreadyAsked);

  // Model routing
  const capability = safeStr(payload.capability || "");
  const chosenModel =
    safeStr(payload.model) ||
    (capability === "vision" ? DEFAULT_VISION_MODEL :
     capability === "audio" ? DEFAULT_AUDIO_MODEL :
     hasImage ? DEFAULT_VISION_MODEL :
     hasAudio ? DEFAULT_AUDIO_MODEL :
     DEFAULT_TEXT_MODEL);

  try {
    // 1) Knowledge snippets (autoKnowledge.js)
    const kb = buildKnowledgeSnippets(text, { locale });
    const knowledgeSnippets = Array.isArray(kb) ? kb : kb ? [String(kb)] : [];

    // 2) Audio transcript (sequential, stable)
    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    // 3) Web search (efficient + optional)
    const doSearch = shouldUseSearch(text);
    const searchSnippets = doSearch ? await tryWebSearch(text, locale) : [];

    // 4) Doctor prompt builder (must enforce user-language replies)
    // buildDoctorMessages should produce message objects or a structure your doctorPrompt defines.
    // We pass everything needed: locale, text, knowledge, search, media flags, transcript, history.
    const doctorPack = buildDoctorMessages({
      locale,
      text,
      knowledgeSnippets,
      searchSnippets,
      hasImage,
      hasAudio,
      audioTranscript,
      alreadyAskedIntake: intakeAlreadyAsked,
      history: normalizeHistory(payload.history || []),
    });

    // Support either:
    // - doctorPack is an array of {role, content}
    // - or doctorPack provides {system, user}
    let systemText = "";
    let userText = "";

    if (Array.isArray(doctorPack)) {
      systemText = safeStr(doctorPack?.find((m) => m?.role === "system")?.content).trim();
      // prefer explicit user message from pack, fallback to text
      userText = safeStr(doctorPack?.find((m) => m?.role === "user")?.content).trim() || text;
    } else {
      systemText = safeStr(doctorPack?.system).trim();
      userText = safeStr(doctorPack?.user).trim() || text;
    }

    // 5) Assemble chat messages (keeps continuity)
    const messages = [];
    if (systemText) messages.push({ role: "system", content: systemText });

    const historyMsgs = normalizeHistory(payload.history || []);
    for (const h of historyMsgs) messages.push({ role: h.role, content: h.content });

    // Current user message with optional image
    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);
      const parts = [];
      if (userText) parts.push({ type: "text", text: userText });
      if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });

      messages.push({
        role: "user",
        content: parts.length ? parts : [{ type: "text", text: userText || "Analyze the image." }],
      });
    } else {
      messages.push({ role: "user", content: userText || text || "Describe the issue." });
    }

    // 6) Call OpenAI (Chat Completions)
    const req = {
      model: chosenModel,
      messages,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    };

    const resp = await createChatCompletionWithFallback(req);

    const reply = safeStr(resp?.choices?.[0]?.message?.content).trim();

    if (!reply) {
      return {
        ok: false,
        reply: "Small issue generating a reply. Please try again.",
        language: locale,
        error: { status: 500, message: "EMPTY_OUTPUT" },
      };
    }

    return {
      ok: true,
      reply,
      language: locale,
      meta: {
        model: chosenModel,
        hasImage,
        hasAudio: Boolean(audioTranscript),
        usedSearch: Boolean(searchSnippets?.length),
        searchCount: searchSnippets?.length || 0,
      },
    };
  } catch (err) {
    const e = openAIErrorToJSON(err);
    console.error("handleFixLensRequest error:", e);

    // English-only fallback (doctorPrompt should handle user-language normally)
    return {
      ok: false,
      reply: "Something went wrong while analyzing. Please try again in a moment.",
      language: locale,
      error: e,
    };
  }
}
