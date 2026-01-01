// lib/service.js (ESM)

// ============================
// Env
// ============================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o"; // set what you have access to
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_URL = "https://google.serper.dev/search";

// ============================
// Small utils
// ============================
function hasArabic(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function nowISO() {
  return new Date().toISOString();
}

function safeTrim(s, n = 2000) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function normalizeMessages(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  const cleaned = arr
    .filter((m) => m && typeof m === "object")
    .map((m) => ({
      role: m.role === "assistant" || m.role === "system" ? m.role : "user",
      content: typeof m.content === "string" ? m.content : "",
    }))
    .filter((m) => m.content.trim().length > 0);

  // Keep last 24 messages to reduce prompt drift
  return cleaned.slice(-24);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content.trim();
  }
  return "";
}

function isValidZip(zip) {
  return typeof zip === "string" && /^\d{5}$/.test(zip.trim());
}

function buildSearchQuery(userText, meta = {}) {
  const zip = (meta.zip || "").trim();
  const cityState = (meta.cityState || "").trim();
  const preferredStore = (meta.preferredStore || "").trim();

  let geo = "";
  if (isValidZip(zip)) geo = ` near ${zip}`;
  else if (cityState) geo = ` near ${cityState}`;

  let store = preferredStore ? ` ${preferredStore}` : "";
  return `${userText}${store}${geo}`.trim();
}

// ============================
// Serper search
// ============================
async function serperSearch({ query, country = "us", location, page = 1 }) {
  if (!SERPER_API_KEY) {
    return { ok: false, error: "SERPER_API_KEY missing" };
  }

  const body = { q: query, gl: country, page };
  if (location) body.location = location;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);

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
      return { ok: false, error: `Serper HTTP ${resp.status} ${safeTrim(txt, 400)}` };
    }

    const data = await resp.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `Serper request failed: ${e?.message || e}` };
  } finally {
    clearTimeout(timeout);
  }
}

function extractTopResults(serperData, limit = 8) {
  const organic = Array.isArray(serperData?.organic) ? serperData.organic : [];
  const local = Array.isArray(serperData?.local) ? serperData.local : [];

  const results = [];

  // Local pack first
  for (const x of local.slice(0, limit)) {
    results.push({
      type: "local",
      title: x?.title || "",
      address: x?.address || "",
      phone: x?.phone || "",
      rating: x?.rating ?? null,
      link: x?.website || x?.link || "",
    });
  }

  // Organic
  for (const x of organic.slice(0, limit)) {
    results.push({
      type: "web",
      title: x?.title || "",
      snippet: x?.snippet || "",
      link: x?.link || "",
    });
  }

  return results.slice(0, limit);
}

// ============================
// OpenAI
// ============================
async function openaiJSON({ system, messages, temperature = 0.2 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model: OPENAI_MODEL_TEXT,
    temperature,
    response_format: { type: "json_object" },
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 800)}`);
  }

  const data = await resp.json();
  const out = data?.choices?.[0]?.message?.content?.trim() || "";
  try {
    return JSON.parse(out);
  } catch (e) {
    // Hard fallback: wrap raw as reply
    return { ok: true, reply: out, _parse_error: true };
  }
}

async function openaiText({ system, messages, temperature = 0.25 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model: OPENAI_MODEL_TEXT,
    temperature,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages,
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 800)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ============================
// Consent card (minimal + not "canned chat", just UI gate)
// ============================
function buildConsentCard(lang, highRisk) {
  if (lang === "ar") {
    return {
      title: highRisk ? "تأكيد سلامة قبل خطوات التصليح" : "تأكيد قبل خطوات التصليح",
      body:
        (highRisk
          ? "الطلب يتضمن إجراء قد يكون خطِرًا (فرامل/وقود/وسائد هوائية/رفع السيارة). "
          : "") +
        "أكد أنك ستعمل على مسؤوليتك، وعندك أدوات سلامة مناسبة، وستتوقف وتراجع مختص إذا صار شيء غير آمن.",
      choices: [
        { id: "accept", label: "أوافق وأكمل" },
        { id: "decline", label: "لا، تشخيص عام فقط" },
      ],
    };
  }

  return {
    title: highRisk ? "Safety confirmation before repair steps" : "Confirmation before repair steps",
    body:
      (highRisk
        ? "This involves a potentially hazardous procedure (brakes/fuel/airbags/lifting). "
        : "") +
      "Confirm you’ll work at your own risk with proper safety tools, and stop/consult a pro if anything feels unsafe.",
    choices: [
      { id: "accept", label: "I agree, continue" },
      { id: "decline", label: "No, general diagnosis only" },
    ],
  };
}

function looksHighRisk(text = "") {
  const t = text.toLowerCase();
  const risky = [
    "airbag",
    "srs",
    "brake line",
    "bleed brakes",
    "brake fluid",
    "fuel leak",
    "gasoline",
    "high voltage",
    "hybrid battery",
    "ev battery",
    "jack stand",
    "lift the car",
    "steering rack",
    "spring compressor",
  ];
  const riskyAr = [
    "ايرباق",
    "وسائد هوائية",
    "srs",
    "فرامل",
    "سائل الفرامل",
    "نزف",
    "بنزين",
    "تسريب",
    "بطارية هايبرد",
    "بطارية كهرب",
    "رافعة",
    "جكات",
    "سست",
  ];
  return risky.some((k) => t.includes(k)) || riskyAr.some((k) => text.includes(k));
}

// ============================
// SUPER SMART 3.5 STAGE
// ============================
export async function handleChat(body) {
  const messages = normalizeMessages(body?.messages);
  const meta = body?.meta || {};
  const userText = lastUserText(messages);
  const lang = hasArabic(userText) ? "ar" : "en";

  // ----------------------------
  // Stage 1: AI Router (Intent + extraction)
  // ----------------------------
  const routerSystem =
    lang === "ar"
      ? `أنت "FixLens Brain Router". مهمتك اتخاذ قرار فقط وإرجاع JSON فقط. لا تكتب شروحات خارج JSON.
Rules:
- FixLens مخصص للسيارات/الشاحنات/الدراجات/الأنظمة الميكانيكية فقط. تجاهل أي موضوع صحي/دايت/وزن.
- استخرج intent: one of ["search_price_store","repair_howto","diagnosis","other"].
- استخرج vehicle: year, make, model إن وُجدت.
- searchNeedZip=true إذا كان intent=search_price_store و لا يوجد ZIP صالح.
- needsConsent=true إذا كان intent=repair_howto و meta.consent.accepted ليس true.
- highRisk=true إذا كان طلب repair_howto ويتضمن أنظمة خطرة (فرامل/وقود/وسائد/رفع/هاي فولت).
Return JSON schema:
{
 "ok": true,
 "language": "ar",
 "intent": "...",
 "vehicle": { "year": null|number, "make": null|string, "model": null|string },
 "searchNeedZip": boolean,
 "needsConsent": boolean,
 "highRisk": boolean,
 "shortSearchQuery": string|null
}`
      : `You are "FixLens Brain Router". Decide only and output JSON only. No extra text.
Rules:
- FixLens is ONLY for vehicles and automotive tools/systems. Ignore health/weight/medical topics.
- intent: one of ["search_price_store","repair_howto","diagnosis","other"].
- extract vehicle: year/make/model if present.
- searchNeedZip=true if intent=search_price_store and no valid ZIP provided.
- needsConsent=true if intent=repair_howto and meta.consent.accepted is not true.
- highRisk=true if repair_howto mentions brakes/fuel/airbags/lifting/high-voltage.
Return JSON:
{
 "ok": true,
 "language": "en",
 "intent": "...",
 "vehicle": { "year": null|number, "make": null|string, "model": null|string },
 "searchNeedZip": boolean,
 "needsConsent": boolean,
 "highRisk": boolean,
 "shortSearchQuery": string|null
}`;

  const router = await openaiJSON({
    system: routerSystem,
    messages: [{ role: "user", content: userText }],
    temperature: 0.0,
  });

  const intent = router?.intent || "diagnosis";
  const needsConsent = !!router?.needsConsent;
  const highRisk = !!router?.highRisk;
  const searchNeedZip = !!router?.searchNeedZip;

  // Consent gate (UI card) — minimal and only when needed
  if (needsConsent) {
    return {
      ok: true,
      language: lang,
      needs_consent: true,
      consent: {
        required: true,
        highRisk,
        card: buildConsentCard(lang, highRisk),
      },
      // minimal line (not a long canned answer)
      reply:
        lang === "ar"
          ? "قبل خطوات التصليح العملية، أحتاج تأكيد سلامة سريع."
          : "Before hands-on repair steps, I need a quick safety confirmation.",
    };
  }

  // ZIP gate for real store/price search
  const zip = (meta?.zip || "").trim();
  const cityState = (meta?.cityState || "").trim();
  const hasGeo = isValidZip(zip) || cityState.length > 2;

  if (intent === "search_price_store" && !hasGeo) {
    return {
      ok: true,
      language: lang,
      needs_zip: true,
      reply:
        lang === "ar"
          ? "حتى أطلع لك محلات قريبة وأسعار حقيقية من المصادر، أرسل ZIP (5 أرقام) أو المدينة/الولاية."
          : "To find nearby stores and real prices from sources, send your ZIP (5 digits) or city/state.",
    };
  }

  // ----------------------------
  // Stage 2: If Search → Serper real search
  // ----------------------------
  let evidence = null;
  if (intent === "search_price_store") {
    const query =
      router?.shortSearchQuery?.trim() ||
      buildSearchQuery(userText, meta);

    const location = isValidZip(zip) ? zip : cityState || undefined;

    const serp = await serperSearch({
      query,
      country: "us",
      location,
      page: 1,
    });

    if (!serp.ok) {
      // Only fallback when search provider is down
      return {
        ok: false,
        language: lang,
        error:
          lang === "ar"
            ? "البحث غير متاح الآن على السيرفر (Serper). حاول بعد قليل."
            : "Search is temporarily unavailable on the server (Serper). Please try again shortly.",
        debug: { where: "serper", detail: serp.error },
      };
    }

    evidence = {
      query,
      geo: location || null,
      results: extractTopResults(serp.data, 8),
      ts: nowISO(),
    };
  }

  // ----------------------------
  // Stage 3: Final Doctor Mechanic answer (AI-First)
  // ----------------------------
  const doctorSystem =
    lang === "ar"
      ? `أنت FixLens Doctor Mechanic (محترف ومدفوع). اكتب بأسلوب هادئ وبسيط (white/neutral language).
قواعد صارمة:
- لا تتكلم عن الصحة/الدايت/الوزن. FixLens للسيارات فقط.
- لا تخترع أسعار أو توفر أو أسماء محلات. إذا لم يظهر السعر بالمصادر قل "السعر غير مذكور".
- لا تستخدم عناوين. لا تستخدم bullets. فقرة واحدة احترافية.
- اسأل أقل عدد ممكن من الأسئلة، فقط إذا كانت ضرورية.
- إذا توفرت EVIDENCE من البحث، استخدمها واذكر 2-5 مصادر كرابط مع الاسم.
- إذا المستخدم يريد "كيف أصلح/أبدل" أعطِ خطوات آمنة وعملية (للميكانيكيين) بعد consent (تم التحقق منه).
مخرجاتك نص فقط.`
      : `You are FixLens Doctor Mechanic (paid, professional). Calm, simple "white language".
Hard rules:
- Automotive only. Never discuss health/weight/medical topics.
- Never invent prices/availability/stores. If price not present in evidence say "price not shown".
- No headings. No bullet points. One professional paragraph.
- Ask only minimal clarifying questions if truly necessary.
- If search EVIDENCE is provided, use it and mention 2-5 sources with links.
- If user asks DIY steps, provide safe practical steps (for mechanics) since consent is already handled.
Output text only.`;

  const finalUserPayload =
    evidence
      ? `USER_REQUEST:\n${userText}\n\nEVIDENCE_JSON:\n${JSON.stringify(evidence)}`
      : `USER_REQUEST:\n${userText}`;

  const reply = await openaiText({
    system: doctorSystem,
    messages: [{ role: "user", content: finalUserPayload }],
    temperature: intent === "diagnosis" ? 0.25 : 0.2,
  });

  // Final response
  return {
    ok: true,
    language: lang,
    reply,
    ...(evidence ? { search: { ok: true, ...evidence } } : {}),
  };
}
