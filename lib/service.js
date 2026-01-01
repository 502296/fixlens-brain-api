// service.js
import { buildDoctorSystemPrompt, buildUserInput, shouldWebSearch } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Choose a stable model that exists in your account.
// If you changed models recently, put it in env: FIXLENS_TEXT_MODEL
const TEXT_MODEL = process.env.FIXLENS_TEXT_MODEL || "gpt-4.1-mini";

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
  const h = history
    .filter((m) => m && typeof m.text === "string" && (m.role === "user" || m.role === "assistant"))
    .slice(-max);
  return h;
}

async function callOpenAIResponses({ system, input, temperature = 0.2 }) {
  if (!OPENAI_KEY) {
    return { ok: false, error: "NO_OPENAI_API_KEY", text: "" };
  }

  const body = {
    model: TEXT_MODEL,
    temperature,
    input: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: [{ type: "text", text: input }] },
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
  // 1) Prepare inputs
  const safeHistory = trimHistory(history, 8);
  const system = buildDoctorSystemPrompt();

  // 2) Decide if we should do web search (price, near me, store, etc.)
  let web = { ok: false, results: [], error: null };
  if (shouldWebSearch(message)) {
    web = await webSearchSerper(message, { gl: "us", hl: "en", num: 5 });
  }

  const userInput = buildUserInput({ message, history: safeHistory, web });

  // 3) Call OpenAI with hard timeout
  const ai = await withTimeout(callOpenAIResponses({ system, input: userInput, temperature: 0.2 }), HARD_TIMEOUT_MS);

  // 4) Fallback if OpenAI fails (never return empty response)
  if (!ai.ok || !ai.text) {
    const detail = ai?.detail || ai?.error || "UNKNOWN";
    const fallback =
      "I could not generate a full response right now. Please try again in a moment. " +
      "If the issue continues, restart the app or check your internet connection. " +
      "You can also re-send your message with the car year/make/model and what happens.";

    return {
      reply: fallback,
      debug: { ok: false, reason: detail, web: web?.ok ? "used" : "not_used" },
    };
  }

  return {
    reply: ai.text,
    debug: { ok: true, web: web?.ok ? "used" : "not_used" },
  };
}
