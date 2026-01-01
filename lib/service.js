// service.js
import { webSearchSerper } from "./search.js"; // your existing search helper
import OpenAI from "openai";

// ----------------------
// 1) In-memory sessions
// ----------------------
const SESSIONS = new Map();

function getSession(sessionId = "anon") {
  if (!SESSIONS.has(sessionId)) {
    SESSIONS.set(sessionId, {
      zip: null,
      pendingLocalQuery: null,     // what we will search once ZIP arrives
      lastAssistantKey: null,      // anti-loop
      updatedAt: Date.now(),
    });
  }
  return SESSIONS.get(sessionId);
}

function setLastAssistantKey(sessionId, key) {
  const s = getSession(sessionId);
  s.lastAssistantKey = key;
  s.updatedAt = Date.now();
}

function repeated(sessionId, key) {
  const s = getSession(sessionId);
  return s.lastAssistantKey === key;
}

// ----------------------
// 2) ZIP helpers
// ----------------------
function normalizeText(x) {
  return String(x ?? "").trim();
}

function isZipOnly(text) {
  const t = normalizeText(text);
  return /^\d{5}$/.test(t);
}

function extractZip(text) {
  const t = normalizeText(text);
  if (/^\d{5}$/.test(t)) return t;
  const m = t.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// ----------------------
// 3) Local search runner
// ----------------------
async function runLocalSearch({ query, zip }) {
  // You can tune query formatting any way you like
  const q = `${query} near ${zip} price AutoZone OR O'Reilly OR NAPA OR Advance Auto Parts`;
  const res = await webSearchSerper(q, { gl: "us", hl: "en", num: 5 });

  if (!res?.ok) {
    return {
      ok: false,
      text: `I couldn’t run web search right now (${res?.error || "SEARCH_FAILED"}).`,
      sources: [],
    };
  }

  // Format simple sources
  const sources = (res.results || []).map(r => ({
    title: r.title,
    link: r.link,
    snippet: r.snippet,
  }));

  // Keep response short + professional
  const text =
    `Here are nearby results for: "${query}" (ZIP ${zip}).\n\n` +
    sources.slice(0, 5).map((s, i) => `${i + 1}) ${s.title}\n${s.link}\n${s.snippet}`).join("\n\n");

  return { ok: true, text, sources };
}

// ----------------------
// 4) Main brain function (you already have something similar)
// ----------------------
export async function handleFixLensMessage({
  sessionId,
  userText,
  imageBase64,
  audioTranscript,
  history = [],
}) {
  const s = getSession(sessionId);

  // ✅ A) ZIP Interceptor (MOST IMPORTANT)
  // If user sent ZIP only -> store and continue pending search immediately.
  if (isZipOnly(userText)) {
    const zip = normalizeText(userText);
    s.zip = zip;
    s.updatedAt = Date.now();

    // If we have a pending query, run it now and clear pending
    if (s.pendingLocalQuery) {
      const pending = s.pendingLocalQuery;
      s.pendingLocalQuery = null;

      const local = await runLocalSearch({ query: pending, zip });
      return {
        ok: local.ok,
        text: local.text,
        mode: "local_search",
        zip,
        sources: local.sources || [],
      };
    }

    // No pending query — just confirm ZIP and ask what to price/search
    return {
      ok: true,
      text: `Got it — ZIP saved: ${zip}. Tell me what part/item you want priced (example: "2016 Honda Civic throttle body").`,
      mode: "zip_saved",
      zip,
    };
  }

  // ✅ B) If user text contains ZIP inside, store it (nice to have)
  const maybeZip = extractZip(userText);
  if (maybeZip) {
    s.zip = maybeZip;
    s.updatedAt = Date.now();
  }

  // ----------------------
  // C) Call OpenAI (your current logic)
  // ----------------------
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Build messages as you currently do (keep your existing doctorPrompt)
  const messages = [
    // your system prompt
    { role: "system", content: process.env.DOCTOR_PROMPT_TEXT || "..." },
    // optional: history
    ...history,
    // user message
    { role: "user", content: userText },
  ];

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini",
    messages,
    temperature: 0.6,
  });

  const assistantText = completion?.choices?.[0]?.message?.content?.trim() || "";

  // ✅ D) Detect ZIP_REQUIRED and set pending query (NO LOOP)
  // We store the user's original request as pendingLocalQuery.
  // Then we respond asking for ZIP ONLY (one line or your UI message).
  if (assistantText === "ZIP_REQUIRED") {
    // Anti-loop guard: don't repeat asking forever
    const ASK_KEY = "ASK_ZIP_V1";
    if (repeated(sessionId, ASK_KEY)) {
      // If repeated, give a fallback: accept last known ZIP or ask once with example
      return {
        ok: true,
        text: `Please send your 5-digit ZIP code only (example: 40218).`,
        mode: "need_zip",
      };
    }
    setLastAssistantKey(sessionId, ASK_KEY);

    // Store what we should search later:
    // If user asked about prices/stores, we treat the whole userText as the pending query.
    s.pendingLocalQuery = userText;
    s.updatedAt = Date.now();

    return {
      ok: true,
      text: `To pull real nearby prices and stores with sources, please send your 5-digit ZIP code only.`,
      mode: "need_zip",
    };
  }

  // ✅ E) (Optional) If you want: if we already have ZIP and user asks for prices,
  // you can auto-run local search without ZIP prompt.
  // Simple heuristic:
  const priceIntent = /price|cost|near me|autozone|oreilly|napa|advance/i.test(userText);
  if (priceIntent && s.zip) {
    const local = await runLocalSearch({ query: userText, zip: s.zip });
    return {
      ok: local.ok,
      text: local.text,
      mode: "local_search",
      zip: s.zip,
      sources: local.sources || [],
    };
  }

  // ✅ Normal reply
  return { ok: true, text: assistantText, mode: "doctor" };
}
