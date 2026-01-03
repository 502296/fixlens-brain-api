// service.js
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

const TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.MODEL_DOCTOR || "gpt-4o-mini";

const TRANSCRIBE_MODEL =
  process.env.FIXLENS_TRANSCRIBE_MODEL || "whisper-1";

const HARD_TIMEOUT_MS = Number(process.env.FIXLENS_TIMEOUT_MS || 25000);

function withTimeout(promise, ms, label = "TIMEOUT") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const m of history) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const c =
      typeof m.content === "string"
        ? m.content
        : typeof m.text === "string"
        ? m.text
        : "";
    if (!c.trim()) continue;
    out.push({ role: m.role, content: c.trim() });
  }
  // Keep more context for continuity, still bounded
  return out.slice(-24);
}

function base64ToBuffer(b64) {
  const cleaned = String(b64 || "").replace(/^data:.*;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

async function transcribeAudio({ base64, mime }) {
  if (!OPENAI_KEY) return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };
  if (!base64) return { ok: false, error: "NO_AUDIO", text: "" };

  const buf = base64ToBuffer(base64);

  // Node 18+ has Blob/FormData globally (Railway usually OK).
  // If your runtime is older, you must upgrade Node or add a polyfill.
  const blob = new Blob([buf], { type: mime || "audio/m4a" });

  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("file", blob, "audio.m4a");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });

  const raw = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, error: `TRANSCRIBE_${r.status}`, detail: raw, text: "" };

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  const text = (data?.text || "").trim();
  return { ok: true, text };
}

async function callOpenAIChat({
  system,
  user,
  history = [],
  image = null,
  temperature = 0.45,
  max_tokens = 1100,
}) {
  if (!OPENAI_KEY) return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };

  const messages = [{ role: "system", content: system }, ...normalizeHistory(history)];

  // Vision: attach image when present
  if (image && image.base64) {
    const mime = image.mime || "image/jpeg";
    const url = `data:${mime};base64,${String(image.base64).replace(/^data:.*;base64,/, "")}`;

    messages.push({
      role: "user",
      content: [
        { type: "text", text: user },
        { type: "image_url", image_url: { url } },
      ],
    });
  } else {
    messages.push({ role: "user", content: user });
  }

  const body = { model: TEXT_MODEL, temperature, max_tokens, messages };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await r.text().catch(() => "");
  if (!r.ok) return { ok: false, error: `OPENAI_${r.status}`, detail: raw, text: "" };

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }

  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  return { ok: true, text };
}

export async function doctorReply({
  text,
  locale = "en",
  history = [],
  image = null,
  audio = null,
  sessionId = null,
}) {
  const message = String(text || "").trim();
  if (!message) return { ok: false, error: "MISSING_TEXT", reply: "" };

  const snippets = buildKnowledgeSnippets(message, { limit: 7, maxCharsEach: 260 });

  const system = buildDoctorSystemPrompt({ locale });

  // If audio exists: transcribe, then inject into user message (so the model stops saying "I can't listen")
  let audioTranscript = "";
  let audioUsed = false;

  if (audio && audio.base64) {
    try {
      const tr = await withTimeout(
        transcribeAudio({ base64: audio.base64, mime: audio.mime || "audio/m4a" }),
        HARD_TIMEOUT_MS,
        "TRANSCRIBE_TIMEOUT"
      );
      if (tr.ok && tr.text) {
        audioTranscript = tr.text;
        audioUsed = true;
      }
    } catch (_) {
      // silent fail; model will proceed without transcript
    }
  }

  const user = buildDoctorUserMessage({
    locale,
    text: message,
    knowledgeSnippets: snippets,
    hasImage: !!(image && image.base64),
    hasAudio: !!(audio && audio.base64),
    audioTranscript,
  });

  const ai = await withTimeout(
    callOpenAIChat({
      system,
      user,
      history,
      image,
      temperature: 0.45,
      max_tokens: 1100,
    }),
    HARD_TIMEOUT_MS
  );

  if (!ai.ok || !ai.text) {
    const fallback =
      "I couldn’t generate a full response right now. Please try again. " +
      "If you can, resend your message with the vehicle year/make/model, mileage, and whether the check engine light is on.";
    return {
      ok: false,
      error: ai?.error || "AI_FAIL",
      reply: fallback,
      meta: {
        model: TEXT_MODEL,
        kb_used: snippets.length,
        sessionId: sessionId || null,
        audio_used: audioUsed,
        vision_used: !!(image && image.base64),
      },
    };
  }

  return {
    ok: true,
    reply: ai.text,
    meta: {
      model: TEXT_MODEL,
      kb_used: snippets.length,
      sessionId: sessionId || null,
      audio_used: audioUsed,
      vision_used: !!(image && image.base64),
    },
  };
}
