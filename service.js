// service.js
import { buildDoctorSystemPrompt, buildUserInput, shouldWebSearch } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Set a stable model via env when you want:
// FIXLENS_TEXT_MODEL=gpt-4.1-mini (recommended baseline)
// or a stronger one later when everything is stable.
const TEXT_MODEL = process.env.FIXLENS_TEXT_MODEL || "gpt-4.1-mini";

// Prevent requests from hanging -> Railway 502.
// Keep this smaller than the Flutter timeout so the server returns first.
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
    .filter(
      (m) =>
        m &&
        typeof m.text === "string" &&
        (m.role === "user" || m.role === "assistant")
    )
    .slice(-max);
}

function safeErrorMessage(err) {
  const m = err?.message || String(err || "UNKNOWN_ERROR");
  // Keep it short for logs, no sensitive info
  return m.length > 220 ? m.slice(0, 220) + "…" : m;
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

  let r;
  try {
    r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: "OPENAI_NETWORK_ERROR", detail: safeErrorMessage(err), text: "" };
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const message = data?.error?.message || `OPENAI_HTTP_${r.status}`;
    return {
      ok: false,
      error: "OPENAI_ERROR",
      detail: typeof message === "string" ? message : String(message),
      http: r.status,
      text: "",
    };
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

async function tryWebSearch(message) {
  // Web search must NEVER crash the request.
  try {
    return await webSearchSerper(message, { gl: "us", hl: "en", num: 5 });
  } catch (err) {
    return { ok: false, error: safeErrorMessage(err), results: [] };
  }
}

export async function textBrain({ message, history = [], meta = {} }) {
  const started = Date.now();

  try {
    // 1) Prepare inputs
    const safeHistory = trimHistory(history, 8);
    const system = buildDoctorSystemPrompt();

    // 2) Web search decision
    let web = { ok: false, results: [], error: null };
    if (shouldWebSearch(message)) {
      web = await tryWebSearch(message);
    }

    const userInput = buildUserInput({ message, history: safeHistory, web });

    // 3) Call OpenAI with hard timeout
    const ai = await withTimeout(
      callOpenAIResponses({ system, input: userInput, temperature: 0.2 }),
      HARD_TIMEOUT_MS,
      "OPENAI_TIMEOUT"
    );

    // 4) Always return a response (never empty)
    if (!ai.ok || !ai.text) {
      const detail = ai?.detail || ai?.error || "UNKNOWN";
      console.log("[FixLensBrain] textBrain fallback:", detail);

      const fallback =
        "I couldn’t generate a full response right now. Please try again. " +
        "If it keeps happening, re-send your message including the car year, make/model, " +
        "and what happens (sounds, dashboard lights, and when it started).";

      return {
        reply: fallback,
        debug: {
          ok: false,
          reason: String(detail),
          web: web?.ok ? "used" : "not_used",
          ms: Date.now() - started,
        },
      };
    }

    return {
      reply: ai.text,
      debug: {
        ok: true,
        web: web?.ok ? "used" : "not_used",
        ms: Date.now() - started,
      },
    };
  } catch (err) {
    // Absolute last-resort guard: never crash the route.
    console.log("[FixLensBrain] textBrain fatal:", safeErrorMessage(err));

    const fallback =
      "I hit an internal error while generating your response. Please try again. " +
      "If it continues, re-send your message with the car year/make/model and what happens.";

    return {
      reply: fallback,
      debug: { ok: false, reason: "INTERNAL_ERROR", ms: Date.now() - started },
    };
  }
}
