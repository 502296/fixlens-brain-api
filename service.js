// service.js — FixLens Brain API (FINAL, stable, PRO)
// Contract: handleFixLensRequest(payload) -> { ok, reply, language, meta, error }

import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Models (set any of these in Railway)
const DEFAULT_TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.FIXLENS_MODEL || "gpt-5-mini";
const DEFAULT_VISION_MODEL =
  process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
const DEFAULT_AUDIO_MODEL =
  process.env.FIXLENS_AUDIO_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";

const MAX_COMPLETION_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 750);
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 20);

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

  // supports {role, content} or {role, text}
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

function looksLikeSearchIntent(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;

  // keep it broad for “addresses/shops/near me”
  return (
    t.includes("near me") ||
    t.includes("nearest") ||
    t.includes("closest") ||
    t.includes("nearby") ||
    t.includes("address") ||
    t.includes("location") ||
    t.includes("shop") ||
    t.includes("garage") ||
    t.includes("mechanic")
  );
}

async function tryWebSearch(query, locale) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const hl = locale === "ar" ? "ar" : "en";
    const gl = "us";

    const r = await webSearchSerper(query, { gl, hl, num: 5 });
    if (!r?.ok) return [];

    // Keep snippets compact but useful
    return (r.results || []).slice(0, 5).map((x) => {
      const title = safeStr(x.title);
      const link = safeStr(x.link);
      const snippet = safeStr(x.snippet);
      return `${title}\n${link}\n${snippet}`.trim();
    });
  } catch {
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

// ✅ MAIN (contract-safe)
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
    // 1) Knowledge
    const kb = buildKnowledgeSnippets(text, { locale });

    // 2) Audio transcript (if audio present)
    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    // 3) Web search snippets (only when it looks like user is asking for places/addresses/etc.)
    const searchSnippets = looksLikeSearchIntent(text)
      ? await tryWebSearch(text, locale)
      : [];

    // 4) Build system/user prompt from doctorPrompt.js (your file)
    const msgs = buildDoctorMessages({
      locale,
      text,
      knowledgeSnippets: Array.isArray(kb) ? kb : (kb ? [String(kb)] : []),
      searchSnippets,
      hasImage,
      hasAudio,
      audioTranscript,
      alreadyAskedIntake: intakeAlreadyAsked,
      history: normalizeHistory(payload.history || []),
    });

    const systemText = safeStr(msgs?.[0]?.content).trim();
    const userText = safeStr(msgs?.[1]?.content).trim();

    // 5) Assemble Chat messages
    const messages = [];

    if (systemText) messages.push({ role: "system", content: systemText });

    // history
    const historyMsgs = normalizeHistory(payload.history || []);
    for (const h of historyMsgs) messages.push(h);

    // current user message + optional image
    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);
      const parts = [];
      if (userText) parts.push({ type: "text", text: userText });
      if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });

      messages.push({
        role: "user",
        content: parts.length ? parts : (userText || "Analyze the image."),
      });
    } else {
      messages.push({ role: "user", content: userText || text || "Describe the issue." });
    }

    // 6) OpenAI call (stable)
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
