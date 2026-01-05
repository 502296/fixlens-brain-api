import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Defaults (safe)
const DEFAULT_TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.FIXLENS_MODEL || "gpt-5-mini";
const DEFAULT_VISION_MODEL =
  process.env.FIXLENS_VISION_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";
const DEFAULT_AUDIO_MODEL =
  process.env.FIXLENS_AUDIO_MODEL || process.env.FIXLENS_MODEL || "gpt-4o";

const MAX_OUTPUT_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 650);
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 20);

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function bufToDataUrl(buffer, mime = "image/jpeg") {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 10) return null;
  const b64 = buffer.toString("base64");
  return `data:${mime};base64,${b64}`;
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

function pickBestOutputText(resp) {
  try {
    const out = resp?.output || [];
    const chunks = [];
    for (const item of out) {
      const parts = item?.content || [];
      for (const p of parts) {
        if (p?.type === "output_text" && p?.text) chunks.push(p.text);
      }
    }
    return chunks.join("").trim();
  } catch {
    return "";
  }
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
    t.includes("garage") ||
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

function buildHistoryParts(history = []) {
  const arr = Array.isArray(history) ? history : [];
  const last = arr.slice(-MAX_TURNS);

  return last
    .map((m) => {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const text = safeStr(m?.content || m?.text || "").trim();
      if (!text) return null;
      return {
        role,
        content: [{ type: "input_text", text }],
      };
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

  // model routing
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

    const audioTranscript = await transcribeAudioIfNeeded({
      hasAudio,
      audioBuffer,
      audioMime,
      audioTranscript: payload.audioTranscript,
    });

    const searchSnippets = looksLikeSearchIntent(text) ? await tryWebSearch(text, locale) : [];

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

    // ✅ Responses API ONLY (this avoids your "input_text" + "max_tokens" errors)
    const input = [];

    if (systemText) {
      input.push({
        role: "system",
        content: [{ type: "input_text", text: systemText }],
      });
    }

    input.push(...buildHistoryParts(history));

    const userParts = [];
    if (userText) userParts.push({ type: "input_text", text: userText });

    if (hasImage && imageBuffer) {
      const dataUrl = bufToDataUrl(imageBuffer, imageMime);
      if (dataUrl) {
        userParts.push({
          type: "input_image",
          image_url: { url: dataUrl },
        });
      }
    }

    input.push({
      role: "user",
      content: userParts.length ? userParts : [{ type: "input_text", text: "" }],
    });

    const resp = await client.responses.create({
      model: chosenModel,
      input,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    const reply =
      pickBestOutputText(resp) ||
      (locale === "ar"
        ? "صار خطأ بسيط بتوليد الرد. جرّب مرة ثانية."
        : "There was a small issue generating a reply. Please try again.");

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
        ? "صار خطأ أثناء التحليل. جرّب مرة ثانية بعد لحظة."
        : "Something went wrong while analyzing. Please try again in a moment.";
    return { ok: false, reply: fallback, language: locale, error: e, meta: { model: chosenModel } };
  }
}
