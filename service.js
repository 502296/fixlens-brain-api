// service.js — FixLens Brain API (PRO, stable, supports text+image+audio+search)
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Defaults
const DEFAULT_TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.FIXLENS_MODEL || "gpt-5-mini";
const DEFAULT_VISION_MODEL =
  process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
const DEFAULT_AUDIO_MODEL =
  process.env.FIXLENS_AUDIO_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";

const MAX_OUTPUT_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 700);
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
  const message =
    safeStr(err?.message) ||
    safeStr(err?.error?.message) ||
    "Unknown error";
  const code = safeStr(err?.code) || safeStr(err?.error?.code) || "";
  const param = safeStr(err?.param) || safeStr(err?.error?.param) || "";
  const request_id =
    safeStr(err?.request_id) ||
    safeStr(err?.response?.headers?.["x-request-id"]) ||
    safeStr(err?.headers?.["x-request-id"]) ||
    "";
  return { status, message, code, param, request_id };
}

function looksLikeSearchIntent(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("near me") ||
    t.includes("closest") ||
    t.includes("nearby") ||
    t.includes("address") ||
    t.includes("location") ||
    t.includes("shop") ||
    t.includes("mechanic") ||
    t.includes("كراج") ||
    t.includes("ورشة") ||
    t.includes("قريب مني") ||
    t.includes("اقرب") ||
    t.includes("وين") ||
    t.includes("عنوان")
  );
}

async function tryWebSearch(query, locale) {
  if (!process.env.SERPER_API_KEY) return [];
  try {
    const hl = locale === "ar" ? "ar" : "en";
    const gl = "us";
    const r = await webSearchSerper(query, { gl, hl, num: 5 });
    if (!r?.ok) return [];
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

function buildHistoryMessages(history = []) {
  const arr = Array.isArray(history) ? history : [];
  const last = arr.slice(-MAX_TURNS);

  return last
    .map((m) => {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = safeStr(m?.content || m?.text || "").trim();
      if (!content) return null;
      return { role, content };
    })
    .filter(Boolean);
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

  const history = Array.isArray(payload.history) ? payload.history : [];
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

    // 2) Audio transcript (if any)
    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    // 3) Web search snippets (optional)
    const searchSnippets = looksLikeSearchIntent(text) ? await tryWebSearch(text, locale) : [];

    // 4) Build doctor sys+user from doctorPrompt.js (English prompt, multilingual output)
    const msgs = buildDoctorMessages({
      locale,
      text,
      knowledgeSnippets: Array.isArray(kb) ? kb : (kb ? [String(kb)] : []),
      searchSnippets,
      hasImage,
      hasAudio,
      audioTranscript,
      alreadyAskedIntake: intakeAlreadyAsked,
      history: history.map((m) => ({ role: m.role, content: m.content })),
    });

    const systemText = safeStr(msgs?.[0]?.content).trim();
    const userText = safeStr(msgs?.[1]?.content).trim();

    // 5) Build Chat Completions messages (✅ avoids your 400 input_text error)
    const chatMessages = [];

    if (systemText) chatMessages.push({ role: "system", content: systemText });

    chatMessages.push(...buildHistoryMessages(history));

    // user message can include text + image
    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);
      chatMessages.push({
        role: "user",
        content: [
          { type: "text", text: userText || text || "" },
          ...(dataUrl ? [{ type: "image_url", image_url: { url: dataUrl } }] : []),
        ],
      });
    } else {
      chatMessages.push({
        role: "user",
        content: userText || text || "",
      });
    }

    const completion = await client.chat.completions.create({
      model: chosenModel,
      messages: chatMessages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.35,
    });

    const reply = safeStr(completion?.choices?.[0]?.message?.content).trim();

    if (!reply) {
      return {
        ok: false,
        reply: locale === "ar"
          ? "صار خطأ بسيط بتوليد الرد. جرّب مرة ثانية."
          : "Small issue generating reply. Try again.",
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
    const fallback =
      locale === "ar"
        ? "حصل خطأ بسيط أثناء التحليل. جرّب مرة ثانية بعد لحظة."
        : "Something went wrong while analyzing. Please try again in a moment.";
    return { ok: false, reply: fallback, language: locale, error: e };
  }
}
