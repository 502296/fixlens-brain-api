// service.js — FixLens Brain API (GPT-5 via Responses API, FINAL)
// ✅ GPT-5 compatible (no chat roles; single instruction input)
// ✅ Matches doctorPrompt.js buildDoctorMessages()
// ✅ Uses autoKnowledge.js + Serper search + Whisper transcription
// ✅ English-only code. Replies in user's language via doctorPrompt rules.

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Defaults
const DEFAULT_MODEL = process.env.FIXLENS_MODEL || "gpt-5";
const MAX_OUTPUT_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 750);

// History is currently injected as summarized text (GPT-5 safe), not role-based chat
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 12);

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

function historyToText(historyMsgs) {
  const msgs = Array.isArray(historyMsgs) ? historyMsgs : [];
  if (!msgs.length) return "";
  // Keep it compact for GPT-5
  return (
    "CONVERSATION HISTORY (most recent last):\n" +
    msgs
      .map((m) => {
        const r = m.role === "assistant" ? "Assistant" : "User";
        return `${r}: ${safeStr(m.content).trim()}`;
      })
      .join("\n")
  ).trim();
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
  const shortQuestion = t.length <= 80 && hasQuestion;

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

function buildInjectedContext({ knowledgeSnippets, searchSnippets, audioTranscript, historyText }) {
  const parts = [];

  if (historyText) {
    parts.push(historyText);
  }

  if (Array.isArray(knowledgeSnippets) && knowledgeSnippets.length) {
    parts.push(
      "AUTO_KNOWLEDGE:\n" +
        knowledgeSnippets.map((s, i) => `${i + 1}. ${safeStr(s)}`).join("\n")
    );
  }

  if (Array.isArray(searchSnippets) && searchSnippets.length) {
    parts.push(
      "WEB_SEARCH_SNIPPETS:\n" +
        searchSnippets.map((s, i) => `${i + 1}. ${safeStr(s)}`).join("\n")
    );
  }

  if (safeStr(audioTranscript).trim()) {
    parts.push("AUDIO_INFO:\n" + safeStr(audioTranscript).trim());
  }

  return parts.filter(Boolean).join("\n\n").trim();
}

function extractResponseText(resp) {
  const direct = safeStr(resp?.output_text).trim();
  if (direct) return direct;

  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        const t = safeStr(c?.text).trim();
        if (t) return t;
      }
    }
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        const t = safeStr(c?.text).trim();
        if (t) return t;
      }
    }
  }
  return "";
}

// ✅ MAIN
export async function handleFixLensRequest(payload = {}) {
  const locale = normalizeLocale(payload.locale || payload.language || "en");
  const chosenModel = safeStr(payload.model) || DEFAULT_MODEL;

  const text = safeStr(payload.text || payload.userText || payload.message || "").trim();

  const hasImage = Boolean(payload.hasImage);
  const imageBuffer = payload.imageBuffer || null;
  const imageMime = safeStr(payload.imageMime) || "image/jpeg";

  const hasAudio = Boolean(payload.hasAudio);
  const audioBuffer = payload.audioBuffer || null;
  const audioMime = safeStr(payload.audioMime) || "audio/mp4";

  const intakeAlreadyAsked = Boolean(payload.intakeAlreadyAsked);

  try {
    // 1) autoKnowledge
    const kb = buildKnowledgeSnippets(text, { locale });
    const knowledgeSnippets = Array.isArray(kb) ? kb : kb ? [String(kb)] : [];

    // 2) audio transcript
    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    // 3) search
    const doSearch = shouldUseSearch(text);
    const needTop3 = doSearch && isNearbyShopsQuery(text);
    const searchSnippets = doSearch ? await tryWebSearch(text, locale, { forceTop3: needTop3 }) : [];

    // 4) doctorPrompt (keep it authoritative)
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

    // 5) compact history injection (GPT-5 safe)
    const historyMsgs = normalizeHistory(payload.history || []);
    const historyText = historyToText(historyMsgs);

    // 6) inject context (kb/search/audio/history)
    const injected = buildInjectedContext({
      knowledgeSnippets,
      searchSnippets,
      audioTranscript,
      historyText,
    });

    const fullInstruction = injected
      ? `${systemBase}\n\n${injected}\n\nUSER MESSAGE:\n${userMessageText || text || "Describe the issue."}`
      : `${systemBase}\n\nUSER MESSAGE:\n${userMessageText || text || "Describe the issue."}`;

    // 7) build GPT-5 compatible input (no roles)
    const content = [{ type: "input_text", text: fullInstruction }];

    // optional image
    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);
      if (dataUrl) content.push({ type: "input_image", image_url: dataUrl });
    }

    // 8) Responses API
    const resp = await client.responses.create({
      model: chosenModel,
      input: content,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    const reply = extractResponseText(resp);

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
