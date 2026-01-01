// service.js
import { buildDoctorSystemPrompt, buildUserInput, shouldWebSearch } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Use your Railway variable if present, otherwise default
const TEXT_MODEL = process.env.OPENAI_MODEL_TEXT || process.env.FIXLENS_TEXT_MODEL || "gpt-5.1";

// Hard timeout to prevent hanging requests -> 502
const HARD_TIMEOUT_MS = Number(process.env.FIXLENS_TIMEOUT_MS || 20000);

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

function trimHistory(history, max = 8) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-max);
}

async function callOpenAIResponses({ system, input, temperature = 0.2 }) {
  if (!OPENAI_KEY) {
    return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };
  }

  // ✅ FIX: Responses API expects `input_text` not `text`
  const body = {
    model: TEXT_MODEL,
    temperature,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: system }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
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
    return { ok: false, error: "OPENAI_ERROR", detail: message, http: r.status, text: "" };
  }

  const text =
    data?.output_text ||
    (Array.isArray(data?.output)
      ? data.output
          .flatMap((o) => o?.content || [])
          .filter((c) => c?.type === "output_text" || c?.type === "text")
          .map((c) => c?.text)
          .join("\n")
      : "");

  return { ok: true, text: (text || "").trim() };
}

export async function textBrain({ message, history = [], meta = {} }) {
  const safeHistory = trimHistory(history, 8);
  const system = buildDoctorSystemPrompt();

  // Web search (optional)
  let web = { ok: false, results: [], error: null };
  try {
    if (shouldWebSearch(message)) {
      web = await webSearchSerper(message, { gl: "us", hl: "en", num: 5 });
    }
  } catch (e) {
    web = { ok: false, results: [], error: "WEB_SEARCH_FAILED" };
  }

  const userInput = buildUserInput({ message, history: safeHistory, web });

  let ai;
  try {
    ai = await withTimeout(
      callOpenAIResponses({ system, input: userInput, temperature: 0.2 }),
      HARD_TIMEOUT_MS
    );
  } catch (e) {
    return {
      reply:
        "I couldn't generate a response right now. Please try again in a moment. If it keeps happening, check the server logs and try again.",
      debug: { ok: false, reason: String(e?.message || e), web: web?.ok ? "used" : "not_used" },
    };
  }

  if (!ai.ok || !ai.text) {
    const detail = ai?.detail || ai?.error || "UNKNOWN";
    return {
      reply:
        "I couldn't generate a response right now. Please try again in a moment. If it keeps happening, check the server logs and try again.",
      debug: { ok: false, reason: detail, web: web?.ok ? "used" : "not_used" },
    };
  }

  return {
    reply: ai.text,
    debug: { ok: true, web: web?.ok ? "used" : "not_used" },
  };
}
