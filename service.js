// lib/service.js

import { buildKnowledgeSnippets } from "./autoKnowledge.js";

import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";



const OPENAI_KEY = process.env.OPENAI_API_KEY;



// Put a stable model here in env to avoid surprises:

const TEXT_MODEL = process.env.FIXLENS_TEXT_MODEL || process.env.MODEL_DOCTOR || "gpt-4o-mini";

const HARD_TIMEOUT_MS = Number(process.env.FIXLENS_TIMEOUT_MS || 20000);



function withTimeout(promise, ms, label = "TIMEOUT") {

  return new Promise((resolve, reject) => {

    const t = setTimeout(() => reject(new Error(label)), ms);

    promise.then(v => { clearTimeout(t); resolve(v); }).catch(e => { clearTimeout(t); reject(e); });

  });

}



function normalizeHistory(history) {

  // Accept either:

  // [{role:"user", content:"..."}] or [{role:"user", text:"..."}]

  if (!Array.isArray(history)) return [];

  const out = [];

  for (const m of history) {

    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;

    const c = typeof m.content === "string" ? m.content : (typeof m.text === "string" ? m.text : "");

    if (!c.trim()) continue;

    out.push({ role: m.role, content: c.trim() });

  }

  return out.slice(-6);

}



async function callOpenAIChat({ system, user, temperature = 0.35, max_tokens = 900 }) {

  if (!OPENAI_KEY) return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };



  const body = {

    model: TEXT_MODEL,

    temperature,

    max_tokens,

    messages: [

      { role: "system", content: system },

      { role: "user", content: user },

    ],

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

  try { data = JSON.parse(raw); } catch { data = null; }



  const text = data?.choices?.[0]?.message?.content?.trim() || "";

  return { ok: true, text };

}



export async function doctorReply({ text, locale = "en", history = [], image = null, audio = null }) {

  const message = String(text || "").trim();

  if (!message) return { ok: false, error: "MISSING_TEXT", reply: "" };



  // Local KB snippets from /data (cheap)

  const snippets = buildKnowledgeSnippets(message, { limit: 7, maxCharsEach: 260 });



  const system = buildDoctorSystemPrompt({ locale });

  const user = buildDoctorUserMessage({

    locale,

    text: message,

    knowledgeSnippets: snippets,

    hasImage: !!(image && image.base64),

    hasAudio: !!(audio && audio.base64),

  });



  // We keep history out of OpenAI call for cost stability.

  // If you want it later, we can merge it safely.

  const ai = await withTimeout(

    callOpenAIChat({ system, user, temperature: 0.35, max_tokens: 900 }),

    HARD_TIMEOUT_MS

  );



  if (!ai.ok || !ai.text) {

    const fallback =

      "I couldn’t generate a full response right now. Please try again. " +

      "If you can, resend your message with the vehicle year/make/model, mileage, and whether the check engine light is on.";

    return { ok: false, error: ai?.error || "AI_FAIL", reply: fallback, meta: { model: TEXT_MODEL, kb_used: snippets.length } };

  }



  return { ok: true, reply: ai.text, meta: { model: TEXT_MODEL, kb_used: snippets.length } };

}



/**

 * Backward-compatible function name for your existing server.js from yesterday:

 * handleFixLensMessage({ sessionId, userText, imageBase64, history })

 * returns: { ok, text }

 */

export async function handleFixLensMessage({ sessionId = "anon", userText, imageBase64 = null, history = [], locale = "en" }) {

  const result = await doctorReply({

    text: userText,

    locale,

    history: normalizeHistory(history),

    image: imageBase64 ? { base64: imageBase64, mime: "image/jpeg" } : null,

    audio: null,

  });



  if (!result.ok) return { ok: false, text: result.reply, meta: result.meta || {} };

  return { ok: true, text: result.reply, meta: result.meta || {} };

}
