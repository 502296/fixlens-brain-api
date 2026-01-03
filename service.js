// service.js
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Models
const TEXT_MODEL =
  process.env.FIXLENS_TEXT_MODEL || process.env.MODEL_DOCTOR || "gpt-4o-mini";

const TRANSCRIBE_MODEL =
  process.env.FIXLENS_TRANSCRIBE_MODEL || "whisper-1";

// Timeouts
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
  // bounded but good continuity
  return out.slice(-24);
}

// ✅ Doctor Mechanic style — no rigid template
const DOCTOR_MECHANIC_STYLE = `
You are FixLens Doctor Mechanic: calm, practical, and professional.
Speak like a real experienced mechanic.

Key behavior:
- Use chat history for continuity. Do NOT restart each message.
- Do NOT repeat the same safety warning every turn.
  Mention driving safety ONLY:
  (1) in the first assistant reply of the session, or
  (2) when new information increases risk.
- Variable length is allowed:
  short for simple questions, longer when unclear or needs steps.
- Causes: up to 3 likely causes MAX, but you may provide more diagnostic steps.
- Ask at most ONE follow-up question only if it changes next action.
- Avoid rigid A/B/C sections. Use brief separators only when helpful.
- Neutral toward mechanics/shops.
- Always reply in the user's language consistently.
`.trim();

function base64ToBuffer(b64) {
  const cleaned = String(b64 || "").replace(/^data:.*;base64,/, "");
  return Buffer.from(cleaned, "base64");
}

// Some Node environments don’t have Blob/FormData guaranteed.
// Railway usually does on Node 18+, but we add safe fallbacks.
async function transcribeAudio({ base64, mime }) {
  if (!OPENAI_KEY) return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };
  if (!base64) return { ok: false, error: "NO_AUDIO", text: "" };

  const buf = base64ToBuffer(base64);

  // Try FormData approach first
  try {
    const form = new FormData();
    form.append("model", TRANSCRIBE_MODEL);

    // If Blob exists, use it; else use File if available; else fallback to Uint8Array
    if (typeof Blob !== "undefined") {
      const blob = new Blob([buf], { type: mime || "audio/m4a" });
      form.append("file", blob, "audio.m4a");
    } else {
      // Fallback: append a Buffer directly (some runtimes accept it)
      form.append("file", buf, "audio.m4a");
    }

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
  } catch (e) {
    // If transcription failed due to runtime FormData/Blob issues, return a clean error
    return { ok: false, error: "TRANSCRIBE_RUNTIME_FAIL", detail: String(e?.message || e), text: "" };
  }
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

  const messages = [
    { role: "system", content: system },
    ...normalizeHistory(history),
  ];

  // ✅ If image present, use vision content format
  if (image && image.base64) {
    const mime = image.mime || "image/jpeg";
    const cleaned = String(image.base64).replace(/^data:.*;base64,/, "");
    const url = `data:${mime};base64,${cleaned}`;

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

  const body = {
    model: TEXT_MODEL,
    temperature,
    max_tokens,
    messages,
  };

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

function isFirstAssistantReply(history) {
  // If there is no assistant message in history, this is the first assistant reply.
  if (!Array.isArray(history)) return true;
  return !history.some((m) => m && m.role === "assistant" && String(m.content || "").trim().length > 0);
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

  const baseSystem = buildDoctorSystemPrompt({ locale });

  // ✅ Add a small “first reply” hint so it won’t repeat warnings every turn
  const firstReply = isFirstAssistantReply(history);
  const firstReplyHint = firstReply
    ? "This is the first assistant reply in this session. Include safety guidance once if relevant."
    : "This is NOT the first assistant reply. Do NOT repeat the same safety warning unless risk increased.";

  const system = `${baseSystem}\n\n${DOCTOR_MECHANIC_STYLE}\n\nSession hint: ${firstReplyHint}`;

  // ✅ Audio transcription (if present)
  let audioTranscript = "";
  let audioOk = false;

  if (audio && audio.base64) {
    const tr = await withTimeout(
      transcribeAudio(audio),
      HARD_TIMEOUT_MS,
      "TRANSCRIBE_TIMEOUT"
    );
    if (tr.ok && tr.text) {
      audioTranscript = tr.text;
      audioOk = true;
    }
  }

  // Build user message from your doctorPrompt.js
  const user = buildDoctorUserMessage({
    locale,
    text: message,
    knowledgeSnippets: snippets,
    hasImage: !!(image && image.base64),
    hasAudio: !!(audio && audio.base64),
  });

  // ✅ Inject transcript in a clean internal block
  const userWithAudio = audioTranscript
    ? `${user}\n\n[Audio transcript — internal]\n${audioTranscript}`
    : user;

  const ai = await withTimeout(
    callOpenAIChat({
      system,
      user: userWithAudio,
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
        vision_used: !!(image && image.base64),
        audio_used: audioOk,
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
      vision_used: !!(image && image.base64),
      audio_used: audioOk,
      transcript: audioTranscript || null,
    },
  };
}
