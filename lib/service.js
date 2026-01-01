// lib/service.js
// AI-First "Super Smart 3.5 stage" service
// - Stage 1: Router (intent + language + search/zip/consent flags)  [English-only prompt]
// - Stage 2: (optional) Search handoff: return needsSearch + searchQuery (no canned reply)
// - Stage 3: Doctor response (diagnosis or repair) via OpenAI         [English-only prompt]
//
// Requirements:
// - Node 18+
// - "openai" npm package v4+
// - Env: OPENAI_API_KEY
// - Optional env: FIXLENS_TEXT_MODEL (default: "gpt-4.1")
// - Optional env: FIXLENS_ROUTER_MODEL (default: FIXLENS_TEXT_MODEL)

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEXT_MODEL = process.env.FIXLENS_TEXT_MODEL || "gpt-4.1";
const ROUTER_MODEL = process.env.FIXLENS_ROUTER_MODEL || TEXT_MODEL;

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function extractJsonFromText(text) {
  // tries to find the first JSON object in a string
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return safeJsonParse(text.slice(start, end + 1));
}

function isProbablyGreetingOnly(t) {
  const s = (t || "").trim().toLowerCase();
  if (!s) return true;
  if (s.length <= 4) return true;
  const greetings = [
    "hi", "hello", "hey", "yo",
    "مرحبا", "هلا", "السلام عليكم", "شلونك",
    "hola", "bonjour", "ciao", "hallo", "ola",
  ];
  return greetings.some((g) => s === g || s.startsWith(g + " "));
}

function applyRouterFallback(routerOut, userText) {
  // Critical FixLens Pro rule:
  // If router returns "other" but user provided a non-trivial description,
  // treat it as diagnosis by default.
  const out = { ...routerOut };

  const text = (userText || "").trim();
  if (!text) return out;

  if ((out.intent === "other" || !out.intent) && text.length > 10 && !isProbablyGreetingOnly(text)) {
    out.intent = "diagnosis";
  }

  // If user asked buy/price/near me but router missed it, catch it:
  const lower = text.toLowerCase();
  const buySignals = ["price", "cost", "how much", "near me", "autozone", "oreilly", "advance auto", "napa", "buy", "purchase"];
  const arBuySignals = ["سعر", "كم السعر", "وين احصل", "قريب", "اوتوزون", "محل", "اشتري"];
  const looksLikeBuy = buySignals.some(s => lower.includes(s)) || arBuySignals.some(s => text.includes(s));

  if (looksLikeBuy) {
    out.intent = "buy_price";
    out.needsSearch = true;
    if (!out.searchQuery) out.searchQuery = text;
  }

  // normalize fields
  if (typeof out.needsSearch !== "boolean") out.needsSearch = false;
  if (typeof out.needsZip !== "boolean") out.needsZip = false;
  if (typeof out.needsConsent !== "boolean") out.needsConsent = false;

  return out;
}

async function callModelJSON({ model, system, user, maxOutputTokens = 350 }) {
  // Uses Responses API style (newer). If your server uses chat.completions, tell me and I’ll adapt.
  const resp = await openai.responses.create({
    model,
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_output_tokens: maxOutputTokens,
  });

  const text = resp.output_text || "";
  const parsed = safeJsonParse(text) || extractJsonFromText(text);
  return { raw: text, json: parsed };
}

/**
 * Main entry for TEXT requests from Flutter:
 * @param {Object} args
 * @param {string} args.text - user message
 * @param {string|null} args.zip - optional ZIP already known
 * @param {string|null} args.outputLanguage - optional forced language (e.g., "en", "ar", "es", "fr", "de", "ja", ...)
 * @param {boolean} args.showSources - if your UI wants sources later
 */
export async function handleText({
  text,
  zip = null,
  outputLanguage = null,
  showSources = false,
} = {}) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: "Server misconfigured: missing OPENAI_API_KEY.",
    };
  }

  const userText = (text || "").toString();
  if (!userText.trim()) {
    return {
      ok: true,
      language: outputLanguage || "en",
      reply: "",
      needsConsent: false,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
    };
  }

  // -------------------------
  // Stage 1 — ROUTER (English-only prompt)
  // -------------------------
  const routerSystem = `
You are FixLens Router (Stage 1). Your job is to classify the user's message and decide what tool/path is needed.

You MUST output STRICT JSON ONLY (no markdown, no extra text).

Goals:
- Understand ANY human language (the user may write in Arabic, Spanish, French, etc.).
- Detect the user's language and set outputLanguage accordingly unless an explicit outputLanguageHint is given.

IMPORTANT (FixLens Pro Rule):
If the user DESCRIBES a vehicle problem or symptom (even without a direct question),
you MUST treat it as intent = "diagnosis".
A problem description IS a request for diagnosis.

Intents (choose one):
- "diagnosis"        : user describes a problem/symptoms and wants guidance/diagnosis
- "repair_steps"     : user asks how to fix/replace/DIY steps
- "buy_price"        : user asks where to buy / near me / price / store / part availability
- "other"            : greetings or totally unrelated

Search rules:
- For "buy_price": set needsSearch=true.
- If ZIP is missing AND the request is local/near-me pricing: set needsZip=true.
- searchQuery: write a concise web search query string (no hallucinated prices/part #s).
- Never invent store results in this stage.

Consent rules:
- If intent="repair_steps" and the request involves safety-critical systems (brakes, SRS/airbags, fuel, lifting/jacking, high voltage),
  set needsConsent=true. Otherwise needsConsent=false.

Output JSON schema:
{
  "intent": "diagnosis"|"repair_steps"|"buy_price"|"other",
  "outputLanguage": "BCP-47 or simple code like en/ar/es/fr/de/ja/zh",
  "needsSearch": boolean,
  "needsZip": boolean,
  "needsConsent": boolean,
  "searchQuery": string|null
}
`;

  const routerUser = JSON.stringify({
    text: userText,
    zipProvided: !!zip,
    outputLanguageHint: outputLanguage || null,
    showSources: !!showSources,
  });

  let router = { intent: "diagnosis", outputLanguage: outputLanguage || "en", needsSearch: false, needsZip: false, needsConsent: false, searchQuery: null };

  try {
    const r = await callModelJSON({
      model: ROUTER_MODEL,
      system: routerSystem,
      user: routerUser,
      maxOutputTokens: 220,
    });

    if (r.json && typeof r.json === "object") {
      router = {
        intent: r.json.intent || router.intent,
        outputLanguage: (outputLanguage || r.json.outputLanguage || router.outputLanguage || "en"),
        needsSearch: !!r.json.needsSearch,
        needsZip: !!r.json.needsZip,
        needsConsent: !!r.json.needsConsent,
        searchQuery: r.json.searchQuery ?? null,
      };
    }
  } catch (e) {
    // Router failed -> still continue as diagnosis, no canned reply
    router = { ...router };
  }

  // Apply hard fallback rules to prevent dumb "no question" responses
  router = applyRouterFallback(router, userText);

  // If outputLanguage forced, respect it
  if (outputLanguage) router.outputLanguage = outputLanguage;

  // If buy_price and zip missing, request ZIP by flag (no canned text)
  if (router.intent === "buy_price") {
    const localSignals = /near me|near|closest|in my area|40218|zip|zipcode|قريب|قريبة|قرب|منطقة/i.test(userText);
    if (!zip && localSignals) router.needsZip = true;
    router.needsSearch = true;
    if (!router.searchQuery) router.searchQuery = userText.trim();
  }

  // -------------------------
  // Stage 2 — SEARCH HANDOFF (no canned reply)
  // Your server can call lib/search.js if you have it.
  // Here we only return flags and the query.
  // -------------------------
  if (router.needsSearch) {
    return {
      ok: true,
      language: router.outputLanguage || "en",
      reply: "", // AI-first: no canned response; UI can trigger search flow
      needsConsent: !!router.needsConsent,
      needsSearch: true,
      needsZip: !!router.needsZip,
      searchQuery: router.searchQuery || userText,
    };
  }

  if (router.needsConsent) {
    // Minimal consent request only (still AI-generated, not canned)
    const consentSystem = `
You are FixLens Doctor Mechanic.
Write ONE short sentence asking for explicit consent to provide DIY repair steps.
Reply ONLY in the target language.
No headings. No bullets.
`;
    const consentUser = JSON.stringify({
      targetLanguage: router.outputLanguage || "en",
      userText,
    });

    try {
      const c = await openai.responses.create({
        model: TEXT_MODEL,
        input: [
          { role: "system", content: consentSystem },
          { role: "user", content: consentUser },
        ],
        max_output_tokens: 90,
      });

      return {
        ok: true,
        language: router.outputLanguage || "en",
        reply: c.output_text || "",
        needsConsent: true,
        needsSearch: false,
        needsZip: false,
        searchQuery: null,
      };
    } catch (e) {
      return {
        ok: false,
        error: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
      };
    }
  }

  // -------------------------
  // Stage 3 — DOCTOR (Diagnosis / general help)
  // -------------------------
  const doctorSystem = `
You are FixLens Doctor Mechanic (paid, professional automotive diagnostician).

Core rules:
- Understand ANY language.
- Reply ONLY in the target language provided.
- One professional paragraph (no headings, no bullet points).
- Calm, direct, practical. Not long. No fluff.

Safety:
- If the user asks for step-by-step DIY repair instructions for safety-critical systems
  (airbags/SRS, brakes, fuel, lifting/jacking, high voltage), ask for explicit consent ONLY and stop.

Anti-hallucination:
- Do not invent prices, store availability, part numbers, or local store facts.
- If the user asks where to buy/price/near me, you must say you need search results and set needsSearch in the router stage (already handled).
`;

  const doctorUser = JSON.stringify({
    targetLanguage: router.outputLanguage || "en",
    userText,
  });

  try {
    const d = await openai.responses.create({
      model: TEXT_MODEL,
      input: [
        { role: "system", content: doctorSystem },
        { role: "user", content: doctorUser },
      ],
      max_output_tokens: 320,
    });

    return {
      ok: true,
      language: router.outputLanguage || "en",
      reply: d.output_text || "",
      needsConsent: false,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
    };
  } catch (e) {
    return {
      ok: false,
      error: "FixLens Brain is busy or unavailable right now. Please try again in a moment.",
    };
  }
}
