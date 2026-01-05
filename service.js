// service.js — FixLens Brain API (PRO, stable NOW)
// Uses Chat Completions with gpt-4o-mini/gpt-4o (stable) to avoid EMPTY_OUTPUT.
// Matches doctorPrompt.js buildDoctorMessages() exactly.
// English-only code. Replies in user's language via doctorPrompt hard rule.

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ IMPORTANT: Use GPT-4o family with chat.completions (stable)
const DEFAULT_TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.FIXLENS_MODEL || "gpt-4o-mini";
const DEFAULT_VISION_MODEL =
  process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
const DEFAULT_AUDIO_MODEL =
  process.env.FIXLENS_AUDIO_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";

const MAX_COMPLETION_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 750);
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 20);

// Search tuning
const SEARCH_NUM_RESULTS = Number(process.env.FIXLENS_SEARCH_NUM || 5);
const SEARCH_GL = process.env.FIXLENS_SEARCH_GL || "us";
const SEARCH_FALLBACK_HL = process.env.FIXLENS_SEARCH_HL || "en";

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

function shouldUseSearch(text) {
  const t = safeStr(text).trim();
  if (!t) return false;

  const lower = t.toLowerCase();
  const triggers = [
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
    "compare",
    "best",
  ];

  if (triggers.some((k) => lower.includes(k))) return true;

  const hasCurrency = /[$€£¥]/.test(t);
  const hasQuestion = /[?？]/.test(t);
  const looksLikeLookup =
    lower.startsWith("http") || lower.includes(".com") || lower.includes("www.") || lower.includes("wiki");
  const shortQuestion = t.length <= 70 && hasQuestion;

  return hasCurrency || looksLikeLookup || shortQuestion;
}

function isNearbyShopsQuery(text) {
  const lower = safeStr(text).toLowerCase();
  if (!lower) return false;
  return (
    lower.includes("near me") ||
    lower.includes("nearby") ||
    lower.includes("closest") ||
    lower.includes("address") ||
    lower.includes("location") ||
    lower.includes("shop") ||
    lower.includes("garage") ||
    lower.includes("mechanic") ||
    lower.includes("dealership")
  );
}

async function tryWebSearch(query, locale, { forceTop3 = false } = {}) {
  if (!process.env.SERPER_API_KEY) return [];

  try {
    const hl = safeStr(locale) || SEARCH_FALLBACK_HL;
    const num = forceTop3 ? 3 : Math.max(1, Math.min(10, SEARCH_NUM_RESULTS));

    const r = await webSearchSerper(query, { gl: SEARCH_GL, hl, num });
    if (!r?.ok) return [];

    const results = (r.results || []).slice(0, num);

    return results
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

// ✅ Move heavy context into SYSTEM injection
function buildSystemInjection({ knowledgeSnippets, searchSnippets, audioTranscript }) {
  let injected = "";

  if (Array.isArray(knowledgeSnippets) && knowledgeSnippets.length) {
    injected +=
      "\nAUTO_KNOWLEDGE:\n" +
      knowledgeSnippets.map((s, i) => `${i + 1}. ${safeStr(s)}`).join("\n") +
      "\n";
  }

  if (Array.isArray(searchSnippets) && searchSnippets.length) {
    injected +=
      "\nWEB_SEARCH_SNIPPETS:\n" +
      searchSnippets.map((s, i) => `${i + 1}. ${safeStr(s)}`).join("\n") +
      "\n";
  }

  if (safeStr(audioTranscript).trim()) {
    injected += "\nAUDIO_INFO:\n" + safeStr(audioTranscript).trim() + "\n";
  }

  return injected.trim();
}

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

  const capability = safeStr(payload.capability || "");
  const chosenModel =
    safeStr(payload.model) ||
    (capability === "vision" ? DEFAULT_VISION_MODEL :
     capability === "audio" ? DEFAULT_AUDIO_MODEL :
     hasImage ? DEFAULT_VISION_MODEL :
     hasAudio ? DEFAULT_AUDIO_MODEL :
     DEFAULT_TEXT_MODEL);

  try {
    const kb = buildKnowledgeSnippets(text, { locale });
    const knowledgeSnippets = Array.isArray(kb) ? kb : kb ? [String(kb)] : [];

    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    const doSearch = shouldUseSearch(text);
    const needTop3 = doSearch && isNearbyShopsQuery(text);
    const searchSnippets = doSearch ? await tryWebSearch(text, locale, { forceTop3: needTop3 }) : [];

    // Build base doctor prompts (keep user small)
    const doctorMsgs = buildDoctorMessages({
      locale,
      text,
      hasImage,
      hasAudio,
      alreadyAskedIntake: intakeAlreadyAsked,
      knowledgeSnippets: [],
      searchSnippets: [],
      audioTranscript: "",
    });

    const systemBase = safeStr(doctorMsgs?.[0]?.content).trim();
    const userMessageText = safeStr(doctorMsgs?.[1]?.content).trim();

    const injected = buildSystemInjection({ knowledgeSnippets, searchSnippets, audioTranscript });

    const messages = [];
    messages.push({
      role: "system",
      content: injected ? `${systemBase}\n\n${injected}` : systemBase,
    });

    const historyMsgs = normalizeHistory(payload.history || []);
    for (const h of historyMsgs) messages.push({ role: h.role, content: h.content });

    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);

      const parts = [];
      if (userMessageText) parts.push({ type: "text", text: userMessageText });
      if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });

      messages.push({
        role: "user",
        content: parts.length ? parts : [{ type: "text", text: userMessageText || "Analyze the image." }],
      });
    } else {
      messages.push({ role: "user", content: userMessageText || text || "Describe the issue." });
    }

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

    return {
      ok: false,
      reply: "Something went wrong while analyzing. Please try again in a moment.",
      language: locale,
      error: e,
    };
  }
}
