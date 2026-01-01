// lib/service.js
// AI-First Super Smart 3.5 Stage
// Stage 1: AI Router -> JSON decision
// Stage 2: Tools (Serper)
// Stage 3: AI Final Answer (Doctor / Search Answer)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

// You can override models in Railway variables:
const MODEL_ROUTER = process.env.OPENAI_MODEL_ROUTER || "gpt-4o-mini";
const MODEL_DOCTOR = process.env.OPENAI_MODEL_DOCTOR || process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const MODEL_SEARCH = process.env.OPENAI_MODEL_SEARCH || "gpt-4o-mini";

const SERPER_URL = "https://google.serper.dev/search";

// -------------------------
// Utils
// -------------------------
function hasArabic(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function nowISO() {
  return new Date().toISOString();
}

function safeTrim(s, n = 1200) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function pickUserTextFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") {
      return messages[i].content.trim();
    }
  }
  return "";
}

// Accept many body shapes (compat with your Flutter)
function normalizeBody(body) {
  const meta = body?.meta || {};

  // If body has direct zip/cityState fields
  if (body?.zip && !meta.zip) meta.zip = String(body.zip);
  if (body?.cityState && !meta.cityState) meta.cityState = String(body.cityState);

  // 1) messages[]
  if (Array.isArray(body?.messages) && body.messages.length) {
    return { messages: body.messages, meta };
  }

  // 2) message string
  if (typeof body?.message === "string" && body.message.trim()) {
    return {
      messages: [{ role: "user", content: body.message.trim() }],
      meta,
    };
  }

  // 3) text string
  if (typeof body?.text === "string" && body.text.trim()) {
    return {
      messages: [{ role: "user", content: body.text.trim() }],
      meta,
    };
  }

  // 4) fallback empty
  return { messages: [], meta };
}

function extractZip(meta = {}) {
  const z = String(meta?.zip || "").trim();
  const m = z.match(/\b(\d{5})\b/);
  return m ? m[1] : "";
}

function extractCityState(meta = {}) {
  const cs = String(meta?.cityState || "").trim();
  return cs.length >= 3 ? cs : "";
}

function consentAccepted(meta = {}) {
  return !!meta?.consent?.accepted;
}

function buildGeoHint(meta = {}) {
  const zip = extractZip(meta);
  const cityState = extractCityState(meta);

  if (zip) return { zip, location: zip, geoText: zip };
  if (cityState) return { zip: "", location: cityState, geoText: cityState };
  return { zip: "", location: "", geoText: "" };
}

function parseJsonLoose(text) {
  if (!text) return null;

  // Try direct JSON
  try {
    return JSON.parse(text);
  } catch {}

  // Try to extract JSON block
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const chunk = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(chunk);
    } catch {}
  }
  return null;
}

function extractTopResults(serperData, limit = 8) {
  const organic = Array.isArray(serperData?.organic) ? serperData.organic : [];
  const local = Array.isArray(serperData?.local) ? serperData.local : [];
  const shopping = Array.isArray(serperData?.shopping) ? serperData.shopping : [];

  const out = [];

  // local pack
  for (const x of local.slice(0, limit)) {
    out.push({
      type: "local",
      title: x?.title || "",
      address: x?.address || "",
      phone: x?.phone || "",
      rating: x?.rating ?? null,
      link: x?.website || x?.link || "",
    });
  }

  // shopping (often includes price)
  for (const x of shopping.slice(0, limit)) {
    out.push({
      type: "shopping",
      title: x?.title || "",
      price: x?.price || "",
      source: x?.source || "",
      link: x?.link || "",
    });
  }

  // organic
  for (const x of organic.slice(0, limit)) {
    out.push({
      type: "web",
      title: x?.title || "",
      snippet: x?.snippet || "",
      link: x?.link || "",
    });
  }

  return out.slice(0, limit);
}

// -------------------------
// OpenAI Chat (with timeout + retry)
// -------------------------
async function openaiChat({ model, system, messages, temperature = 0.2, maxTokens = 800 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const doFetch = async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 300)}`);
      }

      const data = await resp.json();
      return (data?.choices?.[0]?.message?.content || "").trim();
    } finally {
      clearTimeout(t);
    }
  };

  // 1 retry for transient errors
  try {
    return await doFetch();
  } catch (e) {
    // retry once
    return await doFetch();
  }
}

// -------------------------
// Serper
// -------------------------
async function serperSearch({ query, gl = "us", location, page = 1 }) {
  if (!SERPER_API_KEY) {
    return { ok: false, error: "SERPER_API_KEY missing" };
  }

  const body = { q: query, gl, page };
  if (location) body.location = location;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(SERPER_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return { ok: false, error: `Serper HTTP ${resp.status} ${safeTrim(txt, 250)}` };
    }

    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Serper request failed: ${e?.message || e}` };
  } finally {
    clearTimeout(timeout);
  }
}

// -------------------------
// Stage 1: AI Router (JSON)
// -------------------------
async function routeWithAI({ userText, langGuess, meta }) {
  const lang = hasArabic(userText) ? "ar" : (langGuess || "en");

  const system = `
You are FixLens Router (automotive-only).
Decide what to do for the user's LAST message.

Return STRICT JSON only (no prose, no markdown).
Schema:
{
  "language": "ar"|"en",
  "action": "search"|"diagnose"|"repair",
  "needsZip": boolean,
  "needsConsent": boolean,
  "riskLevel": "low"|"high",
  "searchQuery": string|null,
  "askUser": string|null
}

Rules:
- Automotive topics only. If unrelated, still set action="diagnose" and ask a short clarifying question about the car issue.
- action="search" if user asks: where to buy, price, nearby store, availability, part number lookup, "near me".
- needsZip=true if action="search" AND the request is location-based AND zip/city is missing.
- If user just sent a ZIP/city but no part context, set action="search", needsZip=false, and searchQuery should be the previous intent if available in meta. If not available, askUser should request the part + vehicle details again.
- action="repair" if user asks for step-by-step how to replace/fix/DIY.
- needsConsent=true for repair steps, especially if: brakes, fuel, airbags/SRS, lifting, high voltage/EV battery, steering, suspension springs.
- riskLevel="high" when those safety systems are involved.
- language must match user's language (Arabic if they used Arabic).
- askUser must be a single short message in the chosen language. No bullet lists.
`;

  // We help the router by passing minimal meta hints:
  const zip = extractZip(meta);
  const cityState = extractCityState(meta);
  const hint = {
    hasZip: !!zip,
    hasCityState: !!cityState,
    preferredStore: meta?.preferredStore || null,
    // optional: allow Flutter to pass pendingSearchQuery in meta if you implement it later
    pendingSearchQuery: meta?.pendingSearchQuery || null,
  };

  const out = await openaiChat({
    model: MODEL_ROUTER,
    system,
    messages: [
      { role: "user", content: `USER_TEXT:\n${userText}\n\nMETA_HINT:\n${JSON.stringify(hint)}` },
    ],
    temperature: 0.1,
    maxTokens: 450,
  });

  const parsed = parseJsonLoose(out);
  if (!parsed || !parsed.action) {
    // If router failed, we still continue with a sane default using AI again:
    return {
      language: lang,
      action: "diagnose",
      needsZip: false,
      needsConsent: false,
      riskLevel: "low",
      searchQuery: null,
      askUser: lang === "ar"
        ? "اكتب سنة السيارة + الموديل + الأعراض ومتى تظهر."
        : "Share the car year, make/model, symptoms, and when it happens.",
    };
  }

  // harden
  parsed.language = parsed.language === "ar" ? "ar" : "en";
  if (!["search", "diagnose", "repair"].includes(parsed.action)) parsed.action = "diagnose";
  parsed.needsZip = !!parsed.needsZip;
  parsed.needsConsent = !!parsed.needsConsent;
  parsed.riskLevel = parsed.riskLevel === "high" ? "high" : "low";
  if (parsed.searchQuery !== null && typeof parsed.searchQuery !== "string") parsed.searchQuery = null;
  if (parsed.askUser !== null && typeof parsed.askUser !== "string") parsed.askUser = null;

  return parsed;
}

// -------------------------
// Stage 2+3: Doctor + Search Answer (AI only)
// -------------------------
async function doctorAnswer({ lang, messages }) {
  const system =
    lang === "ar"
      ? `You are FixLens Doctor Mechanic (paid, professional automotive diagnostician).
Reply ONLY in Arabic.
Use calm, simple, respectful "white language".
One professional paragraph only. No headings. No bullet points. No lists.
Ask only the minimum clarifying questions if needed.
Never talk about medicine/weight loss. Automotive only.`
      : `You are FixLens Doctor Mechanic (paid, professional automotive diagnostician).
Reply ONLY in English.
Use calm, simple, respectful "white language".
One professional paragraph only. No headings. No bullet points. No lists.
Ask only the minimum clarifying questions if needed.
Never talk about medicine/weight loss. Automotive only.`;

  return await openaiChat({
    model: MODEL_DOCTOR,
    system,
    messages,
    temperature: 0.25,
    maxTokens: 900,
  });
}

async function consentAsk({ lang, userText, riskLevel }) {
  const system =
    lang === "ar"
      ? `You are FixLens. The user asked for DIY/repair steps. You must request explicit safety consent first.
Reply in Arabic.
Write ONE short paragraph only (no bullets).
Include two options at the end in the same paragraph: "أوافق" and "لا، تشخيص فقط".
Be clear but not scary. If riskLevel=high mention brakes/fuel/airbags/lifting/high-voltage safely.`
      : `You are FixLens. The user asked for DIY/repair steps. You must request explicit safety consent first.
Reply in English.
Write ONE short paragraph only (no bullets).
Include two options at the end in the same paragraph: "I agree" and "No, diagnosis only".
Be clear but not scary. If riskLevel=high mention brakes/fuel/airbags/lifting/high-voltage safely.`;

  return await openaiChat({
    model: MODEL_DOCTOR,
    system,
    messages: [{ role: "user", content: `USER_REQUEST:\n${userText}\nRISK_LEVEL:${riskLevel}` }],
    temperature: 0.2,
    maxTokens: 300,
  });
}

async function askForZipWithAI({ lang, userText }) {
  const system =
    lang === "ar"
      ? `You are FixLens. The user wants nearby prices/stores. Ask for ZIP (5 digits) or city/state.
Reply in Arabic. One short paragraph only. No bullets.`
      : `You are FixLens. The user wants nearby prices/stores. Ask for ZIP (5 digits) or city/state.
Reply in English. One short paragraph only. No bullets.`;

  return await openaiChat({
    model: MODEL_DOCTOR,
    system,
    messages: [{ role: "user", content: `USER_TEXT:\n${userText}` }],
    temperature: 0.2,
    maxTokens: 220,
  });
}

async function buildSearchQueryWithAI({ lang, userText, meta }) {
  const { geoText } = buildGeoHint(meta);

  const system =
    lang === "ar"
      ? `You build a web search query for auto parts pricing/availability.
Return ONLY the query string. No quotes. No extra text.
Include vehicle year/make/model + part name + store hints if present + location hint.`
      : `You build a web search query for auto parts pricing/availability.
Return ONLY the query string. No quotes. No extra text.
Include vehicle year/make/model + part name + store hints if present + location hint.`;

  const store = meta?.preferredStore ? String(meta.preferredStore) : "";
  const seed = `USER_TEXT: ${userText}\nSTORE_HINT: ${store}\nLOCATION_HINT: ${geoText}`;

  const q = await openaiChat({
    model: MODEL_ROUTER,
    system,
    messages: [{ role: "user", content: seed }],
    temperature: 0.1,
    maxTokens: 120,
  });

  // keep it clean
  return q.replace(/\s+/g, " ").trim();
}

async function answerWithSearchResults({ lang, userText, query, geoText, results }) {
  const system =
    lang === "ar"
      ? `You are FixLens (automotive). Use the provided web results ONLY.
Do NOT invent prices, stores, or availability.
If a price is missing, say clearly "السعر غير مذكور".
Reply in Arabic.
Style: short, practical. You may format as a compact list if helpful, but avoid long explanations.
Always include the link for each item you mention.`
      : `You are FixLens (automotive). Use the provided web results ONLY.
Do NOT invent prices, stores, or availability.
If a price is missing, say clearly "price not shown".
Reply in English.
Style: short, practical. You may format as a compact list if helpful, but avoid long explanations.
Always include the link for each item you mention.`;

  const data = { query, geo: geoText, results };

  return await openaiChat({
    model: MODEL_SEARCH,
    system,
    messages: [
      {
        role: "user",
        content:
          `User asked:\n${userText}\n\n` +
          `Summarize results. Prefer nearby stores first. If shopping results include price, show it. ` +
          `Output should be concise and actionable.\n\nDATA:\n${JSON.stringify(data)}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 900,
  });
}

async function fallbackWhenSearchFailsAI({ lang, userText, geoText, error }) {
  const system =
    lang === "ar"
      ? `You are FixLens. Web search tool failed.
Reply in Arabic. One short paragraph only. No bullets.
Do NOT invent prices. Offer the fastest next step: ask preferred store and/or part number, and suggest what to search for on their app/site.`
      : `You are FixLens. Web search tool failed.
Reply in English. One short paragraph only. No bullets.
Do NOT invent prices. Offer the fastest next step: ask preferred store and/or part number, and suggest what to search for on their app/site.`;

  return await openaiChat({
    model: MODEL_DOCTOR,
    system,
    messages: [
      {
        role: "user",
        content: `USER_TEXT:\n${userText}\nGEO:\n${geoText}\nERROR:\n${error}`,
      },
    ],
    temperature: 0.2,
    maxTokens: 260,
  });
}

// -------------------------
// Main entry
// -------------------------
export async function handleChat(rawBody) {
  const { messages, meta } = normalizeBody(rawBody);
  const userText = pickUserTextFromMessages(messages);

  if (!userText) {
    // No “ready reply” here; but we can still use AI to ask what they need.
    const lang = "en";
    const reply = await doctorAnswer({
      lang,
      messages: [{ role: "user", content: "Ask the user to describe their car issue." }],
    });
    return { ok: true, reply, ts: nowISO() };
  }

  const langGuess = hasArabic(userText) ? "ar" : "en";

  // ---------- Stage 1: Router ----------
  const route = await routeWithAI({ userText, langGuess, meta });
  const lang = route.language || langGuess;

  // ---------- Repair Consent Flow ----------
  if (route.action === "repair") {
    if (!consentAccepted(meta) || route.needsConsent) {
      const reply = await consentAsk({ lang, userText, riskLevel: route.riskLevel });
      return {
        ok: true,
        reply,
        needs_consent: true,
        consent: {
          required: true,
          riskLevel: route.riskLevel,
        },
        ts: nowISO(),
      };
    }

    // If consent accepted: answer as doctor (still safe)
    const reply = await doctorAnswer({ lang, messages });
    return { ok: true, reply, ts: nowISO() };
  }

  // ---------- Search Flow ----------
  if (route.action === "search") {
    const { geoText, location } = buildGeoHint(meta);

    // If needs ZIP/city
    if (!geoText || route.needsZip) {
      const reply = await askForZipWithAI({ lang, userText });
      return {
        ok: true,
        reply,
        needs_zip: true,
        ts: nowISO(),
      };
    }

    // Build search query (AI) if missing
    const query =
      (typeof route.searchQuery === "string" && route.searchQuery.trim())
        ? route.searchQuery.trim()
        : await buildSearchQueryWithAI({ lang, userText, meta });

    // If SERPER not configured => AI must explain
    if (!SERPER_API_KEY) {
      const reply = await fallbackWhenSearchFailsAI({
        lang,
        userText,
        geoText,
        error: "SERPER_API_KEY missing on server",
      });
      return {
        ok: true,
        reply,
        search: { ok: false, reason: "SERPER_API_KEY missing", query },
        ts: nowISO(),
      };
    }

    const serp = await serperSearch({ query, gl: "us", location, page: 1 });

    if (!serp.ok) {
      const reply = await fallbackWhenSearchFailsAI({
        lang,
        userText,
        geoText,
        error: serp.error,
      });
      return {
        ok: true,
        reply,
        search: { ok: false, error: serp.error, query },
        ts: nowISO(),
      };
    }

    const results = extractTopResults(serp.data, 10);
    const reply = await answerWithSearchResults({ lang, userText, query, geoText, results });

    return {
      ok: true,
      reply,
      search: { ok: true, query, geo: geoText, results },
      ts: nowISO(),
    };
  }

  // ---------- Diagnose Flow ----------
  const reply = await doctorAnswer({ lang, messages });
  return { ok: true, reply, ts: nowISO() };
}
