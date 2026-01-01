// service.js
import { buildDoctorSystemPrompt, buildUserInput, shouldWebSearch } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

// Read your Railway variables (current names)
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const TEXT_MODEL =
  process.env.OPENAI_MODEL_TEXT ||         // your current variable
  process.env.FIXLENS_TEXT_MODEL ||        // optional alt variable
  "gpt-4o-mini";                           // safe default

const HARD_TIMEOUT_MS = Number(process.env.FIXLENS_TIMEOUT_MS || 60000);
const DEBUG = String(process.env.FIXLENS_DEBUG || "").trim() === "1";

function withTimeout(promise, ms, label = "TIMEOUT") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    promise
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); reject(e); });
  });
}

function trimHistory(history, max = 8) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-max);
}

function extractOutputText(data) {
  if (!data) return "";
  if (typeof data.output_text === "string") return data.output_text;

  if (Array.isArray(data.output)) {
    const parts = data.output
      .flatMap((o) => Array.isArray(o?.content) ? o.content : [])
      .filter((c) => c?.type === "output_text" || c?.type === "text")
      .map((c) => c?.text)
      .filter(Boolean);
    return parts.join("\n");
  }
  return "";
}

async function callOpenAIResponses({ system, input, temperature = 0.2 }) {
  if (!OPENAI_KEY) {
    return { ok: false, error: "NO_OPENAI_API_KEY", http: 0, detail: "Missing OPENAI_API_KEY", text: "" };
  }

  const body = {
    model: TEXT_MODEL,
    temperature,
    input: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: [{ type: "text", text: input }] }
    ],
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const message = data?.error?.message || `OPENAI_HTTP_${r.status}`;
    return { ok: false, error: "OPENAI_ERROR", http: r.status, detail: message, text: "" };
  }

  const text = extractOutputText(data).trim();
  return { ok: true, http: 200, text };
}

export async function textBrain({ message, history = [], meta = {} }) {
  const safeHistory = trimHistory(history, 8);
  const system = buildDoctorSystemPrompt();

  let web = { ok: false, results: [], error: null };
  try {
    if (shouldWebSearch(message)) {
      web = await webSearchSerper(message, { gl: "us", hl: "en", num: 5 });
    }
  } catch (e) {
    web = { ok: false, results: [], error: e?.message || "WEB_SEARCH_FAILED" };
  }

  const userInput = buildUserInput({ message, history: safeHistory, web });

  let ai;
  try {
    ai = await withTimeout(
      callOpenAIResponses({ system, input: userInput, temperature: 0.2 }),
      HARD_TIMEOUT_MS
    );
  } catch (e) {
    const reason = e?.message || "OPENAI_CALL_FAILED";
    console.error("OPENAI_CALL_EXCEPTION:", reason, e?.stack || "");
    return {
      reply:
        "I couldn’t generate a response right now. Please try again in a moment. " +
        "If it keeps happening, check the server logs for the OpenAI error and try again.",
      debug: DEBUG ? { ok: false, reason, model: TEXT_MODEL } : { ok: false },
    };
  }

  if (!ai.ok || !ai.text) {
    console.error("OPENAI_CALL_BAD:", {
      ok: ai?.ok,
      http: ai?.http,
      error: ai?.error,
      detail: ai?.detail,
      model: TEXT_MODEL,
    });

    return {
      reply:
        "I couldn’t generate a response right now. Please try again in a moment. " +
        "If it keeps happening, check the server logs for the OpenAI error and try again.",
      debug: DEBUG
        ? { ok: false, reason: ai?.detail || ai?.error || "UNKNOWN", http: ai?.http || 0, model: TEXT_MODEL }
        : { ok: false },
    };
  }

  return {
    reply: ai.text,
    debug: DEBUG ? { ok: true, model: TEXT_MODEL, web: web?.ok ? "used" : "not_used" } : { ok: true },
  };
}
