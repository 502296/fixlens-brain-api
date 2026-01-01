// lib/service.js
import OpenAI from "openai";
import { webSearchSerper } from "./search.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * =========================
 *  FixLens Pro System Prompt
 *  (English only, multilingual output)
 * =========================
 */
function buildDoctorSystemPrompt({ outputLanguage = "en" } = {}) {
  return `
You are FixLens Doctor Mechanic (paid, professional).
You MUST think in English, but you MUST reply ONLY in the user's requested outputLanguage.

LANGUAGE:
- Reply ONLY in ${outputLanguage}.
- Be fluent and natural in that language (any world language).
- Never mix languages in the same reply unless the user explicitly asks.

STYLE (CRITICAL):
- One professional paragraph ONLY (no headings, no bullet points).
- Calm, direct, practical.
- Not long, not short: "worth paying for".

DIAGNOSTIC FLOW (INVISIBLE, but must be followed):
- Show you understood the symptom.
- Give likely causes (prioritized).
- Say if it's safe to drive / immediate risk.
- Give practical next steps (tests/inspections) in real mechanic style.
- If relevant: parts/solutions and realistic cost ranges (as estimates).
- If user asked local price/where-to-buy: ask for ZIP if missing, otherwise request live search.

SAFETY / CONSENT (MANDATORY):
If the user asks for DIY repair steps ("how to fix", "replace", "steps", "procedure") especially involving:
- brakes, airbags/SRS, fuel systems, lifting/jacks, high voltage (EV/hybrid), steering/suspension critical items
You MUST require explicit consent before giving steps.
If consent is missing: ask ONLY for consent and stop.

ANTI-HALLUCINATION:
- Never invent part numbers, store inventory, exact prices, or availability.
- If live search results are provided, summarize them and cite sources using [1], [2], [3] in the reply.
- If no search results are provided, say you cannot browse prices/availability right now.

OUTPUT JSON ONLY:
Return exactly:
{
  "ok": true,
  "language": "${outputLanguage}",
  "reply": "string",
  "needsConsent": false,
  "needsSearch": false,
  "needsZip": false,
  "searchQuery": "string|null",
  "sources": [{"title":"", "link":"", "snippet":""}]
}

Rules:
- needsConsent=true if repair steps requested and consent is missing.
- needsSearch=true + searchQuery if user asked where to buy/price/near me.
- needsZip=true if local buying/pricing requested and ZIP is missing.
- sources must be an array (empty if none).
`;
}

/**
 * =========================
 * Stage 1 Router (Smart + Safe)
 * - Your requirement: ANY vehicle problem description => diagnosis automatically
 * - If user asks price/where to buy/near me => search intent
 * =========================
 */
function classifyIntent(text = "") {
  const t = (text || "").toLowerCase();

  // Debug route (keeps your TEST_ROUTE_123 ability)
  if (t.includes("test_route_123")) return "test";

  // Search intent keywords
  const searchHints = [
    "price", "cost", "how much", "where to buy", "buy", "near me", "near", "autozone", "o'reilly",
    "advance auto", "napa", "walmart", "amazon", "ebay", "part store", "sell", "availability",
    "40218", "zip", "louisville", "kentucky"
  ];

  // Arabic / multilingual hints (still treated same)
  const searchHintsAr = [
    "سعر", "كم السعر", "وين", "أين", "أشتري", "محل", "قريب", "قريبة", "منطقتي", "أوتوزون", "اوريلي"
  ];

  if (searchHints.some(k => t.includes(k)) || searchHintsAr.some(k => t.includes(k))) {
    return "search";
  }

  // If it's any symptom/problem (default): diagnosis
  return "diagnosis";
}

/**
 * =========================
 * Consent Gate
 * =========================
 */
function asksForRepairSteps(text = "") {
  const t = (text || "").toLowerCase();
  const stepWords = ["how to", "steps", "procedure", "replace", "install", "remove", "fix it myself", "diy", "walk me through"];
  const stepWordsAr = ["شلون", "كيف", "خطوات", "بدّل", "استبدال", "أصلح", "اصلاح", "بنفسى", "نفسي", "طريقة"];

  const safetySystems = ["brake", "brakes", "rotor", "caliper", "airbag", "srs", "fuel", "jack", "lift", "high voltage", "hybrid", "ev", "steering", "control arm"];
  const safetySystemsAr = ["فرامل", "ديسك", "روتر", "ايرباق", "وسادة", "بنزين", "وقود", "رافعة", "جاك", "هايبرد", "كهرباء", "ستيرنغ", "دركسون", "مقود"];

  const wantsSteps = stepWords.some(k => t.includes(k)) || stepWordsAr.some(k => t.includes(k));
  const isSafety = safetySystems.some(k => t.includes(k)) || safetySystemsAr.some(k => t.includes(k));

  return wantsSteps && isSafety;
}

function hasExplicitConsent(consent) {
  if (consent === true) return true;
  const t = (typeof consent === "string" ? consent : "").toLowerCase();
  return t.includes("i consent") || t.includes("i understand") || t.includes("yes i want steps") ||
         t.includes("اوافق") || t.includes("نعم اوافق") || t.includes("موافق") || t.includes("اعطي الخطوات");
}

/**
 * =========================
 * Build a strong search query (localized)
 * =========================
 */
function buildSearchQuery({ message, zip }) {
  // Keep query in English for better search, even if message is Arabic.
  // We include zip for local relevance.
  const base = message.replace(/\s+/g, " ").trim();
  const z = zip ? ` near ${zip}` : "";
  return `${base}${z}`.slice(0, 180);
}

/**
 * =========================
 * Stage 2/3: LLM Call helper
 * =========================
 */
async function callDoctorLLM({ outputLanguage, userText, searchResults = [] }) {
  const model = process.env.FIXLENS_MODEL_TEXT || "gpt-4o"; // you can set to gpt-5.1 later
  const system = buildDoctorSystemPrompt({ outputLanguage });

  const context =
    searchResults && searchResults.length
      ? `\n\nLIVE SEARCH RESULTS (use these and cite [1],[2]...):\n` +
        searchResults.map((r, i) => `[${i + 1}] ${r.title}\n${r.link}\n${r.snippet}`).join("\n\n")
      : "";

  // We ask the model to output strict JSON only (as required by system prompt)
  const input = [
    { role: "system", content: system },
    { role: "user", content: `${userText}${context}` },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages: input,
    temperature: 0.3,
    max_tokens: 450,
  });

  const raw = resp.choices?.[0]?.message?.content?.trim() || "";

  // Strict JSON parsing (with safe fallback)
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    const sliced = jsonStart >= 0 && jsonEnd >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;
    const obj = JSON.parse(sliced);

    // Normalize required fields
    obj.ok = true;
    obj.language = outputLanguage;
    obj.sources = Array.isArray(obj.sources) ? obj.sources : [];
    return obj;
  } catch {
    // If model output isn't JSON, we still return one safe JSON envelope
    return {
      ok: true,
      language: outputLanguage,
      reply: raw || "Please try again.",
      needsConsent: false,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
      sources: [],
    };
  }
}

/**
 * =========================
 * Main Handler for server.js
 * =========================
 * Expected body from Flutter:
 * {
 *   "message": "text",
 *   "outputLanguage": "ar" | "en" | "es" ...,
 *   "zip": "40218" (optional),
 *   "consent": true | "I consent..." (optional)
 * }
 */
export async function handleDiagnose(body, { requestId } = {}) {
  const message = String(body?.message || "").trim();
  const outputLanguage = String(body?.outputLanguage || "en").trim();
  const zip = body?.zip ? String(body.zip).trim() : "";
  const consent = body?.consent;

  if (!message) {
    // Minimal value, not a canned “chatbot” reply—just ask for input
    return {
      ok: true,
      language: outputLanguage,
      reply: outputLanguage === "ar"
        ? "اكتب وصف المشكلة أو الأعراض اللي تشوفها (حتى لو سطر واحد) وأنا أبدأ التشخيص مباشرة."
        : "Describe the symptom you’re seeing (even one sentence) and I’ll start the diagnosis immediately.",
      needsConsent: false,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
      sources: [],
    };
  }

  // Consent gate (only when user asks for steps on safety systems)
  if (asksForRepairSteps(message) && !hasExplicitConsent(consent)) {
    // Ask ONLY for consent and stop
    const consentReply =
      outputLanguage === "ar"
        ? "قبل ما أعطيك خطوات إصلاح/استبدال لأن الموضوع يمسّ السلامة (مثل الفرامل/الرفع/الوقود/الوسائد الهوائية)، هل تؤكد أنك تفهم المخاطر وتريد الخطوات على مسؤوليتك؟ اكتب: (نعم أوافق) فقط."
        : "Before I give step-by-step repair instructions (safety-critical systems like brakes/fuel/lifting/SRS), please confirm you understand the risks and still want the steps on your responsibility. Reply with: “I consent”.";
    return {
      ok: true,
      language: outputLanguage,
      reply: consentReply,
      needsConsent: true,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
      sources: [],
    };
  }

  // Stage 1 routing
  const intent = classifyIntent(message);

  // TEST route (debug)
  if (intent === "test") {
    return {
      ok: true,
      language: outputLanguage,
      reply: outputLanguage === "ar" ? "TEST OK: route=test" : "TEST OK: route=test",
      needsConsent: false,
      needsSearch: false,
      needsZip: false,
      searchQuery: null,
      sources: [],
    };
  }

  // Stage 2: Search intent
  if (intent === "search") {
    // If local price/nearby requested, require ZIP
    const needsZip = !zip || zip.length < 5;

    if (needsZip) {
      return {
        ok: true,
        language: outputLanguage,
        reply: outputLanguage === "ar"
          ? "حتى أطلع لك أسعار ومحلات قريبة بمصادر حقيقية، ارسل ZIP (5 أرقام) فقط."
          : "To pull real nearby prices and stores with sources, please send your 5-digit ZIP code only.",
        needsConsent: false,
        needsSearch: true,
        needsZip: true,
        searchQuery: null,
        sources: [],
      };
    }

    const searchQuery = buildSearchQuery({ message, zip });

    const s = await webSearchSerper(searchQuery, { gl: "us", hl: "en", num: 5 });

    // If SERPER missing or failed: tell truth (no fake prices)
    if (!s.ok) {
      return {
        ok: true,
        language: outputLanguage,
        reply: outputLanguage === "ar"
          ? "حاليًا البحث المباشر غير متاح عندي (Search API غير مفعّل). إذا تفعّله أطلع لك أسعار ومصادر فورًا."
          : "Live search is not available right now (Search API isn’t enabled). Once it’s enabled, I can fetch real prices and sources instantly.",
        needsConsent: false,
        needsSearch: true,
        needsZip: false,
        searchQuery,
        sources: [],
      };
    }

    // Stage 3: Let the doctor summarize results + cite them
    const doctor = await callDoctorLLM({
      outputLanguage,
      userText: message,
      searchResults: s.results,
    });

    // Ensure we include sources (so app can show them cleanly)
    doctor.needsSearch = false;
    doctor.needsZip = false;
    doctor.searchQuery = searchQuery;
    doctor.sources = s.results;

    return doctor;
  }

  // Stage 2/3: Diagnosis intent (default for ANY symptom)
  const doctor = await callDoctorLLM({
    outputLanguage,
    userText: message,
    searchResults: [],
  });

  // If the model decides it needs live search (e.g., user asked price), respect it
  // But we keep our router as primary. Model may set needsSearch true.
  if (doctor.needsSearch === true) {
    // If zip missing -> request zip
    const needsZip = !zip || zip.length < 5;
    if (needsZip) {
      return {
        ok: true,
        language: outputLanguage,
        reply: outputLanguage === "ar"
          ? "أقدر أطلع لك أسعار ومصادر حقيقية، بس ارسل ZIP (5 أرقام) فقط."
          : "I can fetch real prices and sources—please send your 5-digit ZIP code only.",
        needsConsent: false,
        needsSearch: true,
        needsZip: true,
        searchQuery: null,
        sources: [],
      };
    }

    const searchQuery = buildSearchQuery({ message, zip });
    const s = await webSearchSerper(searchQuery, { gl: "us", hl: "en", num: 5 });
    if (s.ok) {
      const doctor2 = await callDoctorLLM({
        outputLanguage,
        userText: message,
        searchResults: s.results,
      });
      doctor2.searchQuery = searchQuery;
      doctor2.sources = s.results;
      doctor2.needsSearch = false;
      doctor2.needsZip = false;
      return doctor2;
    }

    // If search failed, tell truth
    doctor.reply =
      outputLanguage === "ar"
        ? "أحتاج بحث مباشر حتى أعطيك أسعار ومصادر بدون تخمين، لكن البحث غير متاح الآن. إذا تفعل Search API أجيبها لك فورًا."
        : "I need live search to provide prices and sources without guessing, but search isn’t available right now. Enable Search API and I’ll fetch them instantly.";
    doctor.sources = [];
    doctor.searchQuery = searchQuery;
  }

  doctor.sources = Array.isArray(doctor.sources) ? doctor.sources : [];
  return doctor;
}
