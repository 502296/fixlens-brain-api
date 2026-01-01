// lib/service.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";

const SERPER_URL = "https://google.serper.dev/search";

// ============================
// Helpers
// ============================

function hasArabic(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function pickUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i]?.content === "string") {
      return messages[i].content.trim();
    }
  }
  return "";
}

function safeTrim(s, n = 1200) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function isSearchIntent(text = "") {
  const t = text.toLowerCase();
  const searchHints = [
    "where can i buy",
    "how much",
    "price",
    "near me",
    "store",
    "buy ",
    "order ",
    "part number",
    "autozone",
    "o'reilly",
    "advance auto",
    "napa",
    "walmart",
    "amazon",
    "ebay",
    "dealer",
    "dealership",
    "find ",
    "lookup ",
    "availability",
    "in stock",
    "ship",
    "shipping",
  ];

  const searchHintsAr = [
    "وين",
    "أين",
    "منين أشتري",
    "اشتري",
    "سعر",
    "كم السعر",
    "وين احصل",
    "قريب",
    "قريبة مني",
    "محل",
    "متجر",
    "متوفر",
    "موجود",
    "اوتوزون",
    "اوريلي",
    "نابا",
  ];

  return searchHints.some((k) => t.includes(k)) || searchHintsAr.some((k) => text.includes(k));
}

function isRepairHowToIntent(text = "") {
  const t = text.toLowerCase();
  const howto = [
    "how do i fix",
    "how to replace",
    "how to change",
    "step by step",
    "install",
    "remove",
    "repair",
    "replace",
    "swap",
    "bleed brakes",
    "airbag",
    "srs",
    "fuel pump",
    "spark plug",
    "coil",
    "throttle body cleaning",
    "timing belt",
    "timing chain",
    "brake pads",
    "brake caliper",
    "strut",
    "control arm",
  ];
  const howtoAr = [
    "شلون",
    "كيف أصلح",
    "طريقة تصليح",
    "خطوة بخطوة",
    "استبدال",
    "تبديل",
    "تنظيف",
    "تركيب",
    "فك",
    "مضخة البنزين",
    "وسائد هوائية",
    "ايرباق",
    "فرامل",
    "بواجي",
    "كويلات",
    "سير",
    "جنزير",
  ];
  return howto.some((k) => t.includes(k)) || howtoAr.some((k) => text.includes(k));
}

function isHighRiskTopic(text = "") {
  const t = text.toLowerCase();
  const risky = [
    "airbag",
    "srs",
    "brake line",
    "brake fluid",
    "bleed brakes",
    "fuel leak",
    "gasoline",
    "high voltage",
    "hybrid battery",
    "ev battery",
    "steering rack",
    "suspension spring",
  ];
  const riskyAr = ["ايرباق", "وسائد هوائية", "فرامل", "سائل الفرامل", "بنزين", "تسريب", "بطارية هايبرد", "بطارية كهرب"];
  return risky.some((k) => t.includes(k)) || riskyAr.some((k) => text.includes(k));
}

function buildConsentCard(lang, highRisk) {
  if (lang === "ar") {
    return {
      title: highRisk ? "تنبيه سلامة قبل إرشادات التصليح" : "موافقة قبل إرشادات التصليح",
      body:
        (highRisk ? "الطلب يتضمن إجراء قد يكون خطِرًا (مثل الفرامل/الوقود/الوسائد الهوائية). " : "") +
        "قبل أن أعطيك خطوات عملية: أنت تعمل على مسؤوليتك، وعندك أدوات/معدات سلامة مناسبة، وإذا حسّيت خطر أو مو متأكد تتوقف وتراجع مختص.",
      choices: [
        { id: "accept", label: "أوافق وأكمل" },
        { id: "decline", label: "لا، تشخيص عام فقط" },
      ],
    };
  }

  return {
    title: highRisk ? "Safety confirmation before repair steps" : "Confirmation before repair steps",
    body:
      (highRisk ? "Your request involves a potentially hazardous procedure (brakes/fuel/airbags). " : "") +
      "Before I give hands-on steps: you confirm you have proper safety gear/tools and will work at your own risk, stop if unsure, and consult a professional if unsafe.",
    choices: [
      { id: "accept", label: "I agree, continue" },
      { id: "decline", label: "No, general diagnosis only" },
    ],
  };
}

// ============================
// OpenAI
// ============================

async function openaiChat({ system, messages, temperature = 0.3 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model: MODEL_TEXT,
    temperature,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
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
    throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 300)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ============================
// Serper
// ============================

async function serperSearch({ query, country = "us", location, page = 1 }) {
  if (!SERPER_API_KEY) return { ok: false, error: "SERPER_API_KEY missing" };

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

function extractTopResults(serperData, limit = 6) {
  const organic = Array.isArray(serperData?.organic) ? serperData.organic : [];
  const local = Array.isArray(serperData?.local) ? serperData.local : [];

  const results = [];

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

function buildSearchQuery(userText, meta = {}) {
  const zip = meta?.zip?.trim();
  const cityState = meta?.cityState?.trim();
  const preferredStore = meta?.preferredStore?.trim();

  let geo = "";
  if (zip && /^\d{5}$/.test(zip)) geo = ` near ${zip}`;
  else if (cityState) geo = ` near ${cityState}`;

  let store = preferredStore ? ` ${preferredStore}` : "";
  return `${userText}${store}${geo}`.trim();
}

// ============================
// Search ping endpoint helper
// ============================

export async function handleSearchPing({ q, zip, cityState }) {
  const query = (q || "").trim();
  if (!query) return { ok: false, error: "Missing q" };

  const location = zip && /^\d{5}$/.test(zip) ? zip : (cityState || "").trim() || undefined;

  const serp = await serperSearch({
    query,
    country: "us",
    location,
    page: 1,
  });

  if (!serp.ok) {
    return { ok: false, error: serp.error, hasKey: !!SERPER_API_KEY };
  }

  return {
    ok: true,
    hasKey: true,
    sample: extractTopResults(serp.data, 5),
  };
}

// ============================
// Main chat
// ============================

export async function handleChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const meta = body?.meta || {};
  const userText = pickUserText(messages);
  const lang = hasArabic(userText) ? "ar" : "en";

  // (A) Consent gate for HOW-TO
  const wantsHowTo = isRepairHowToIntent(userText);
  const highRisk = wantsHowTo && isHighRiskTopic(userText);
  const consentAccepted = !!meta?.consent?.accepted;

  if (wantsHowTo && !consentAccepted) {
    const card = buildConsentCard(lang, highRisk);
    return {
      ok: true,
      needs_consent: true,
      consent: { required: true, highRisk, card },
      reply:
        lang === "ar"
          ? "قبل ما أعطيك خطوات تصليح عملية، لازم تأكيد سلامة سريع."
          : "Before I share hands-on repair steps, I need a quick safety confirmation.",
    };
  }

  // (B) Search intent
  if (isSearchIntent(userText)) {
    const zip = meta?.zip?.trim();
    const cityState = meta?.cityState?.trim();
    const hasGeo = (zip && /^\d{5}$/.test(zip)) || (!!cityState && cityState.length > 2);

    if (!hasGeo) {
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "حتى أطلع لك محلات قريبة وأسعار حقيقية، أرسل ZIP (5 أرقام) أو المدينة/الولاية."
            : "To find nearby stores and real prices, send your ZIP code (5 digits) or your city/state.",
      };
    }

    const query = buildSearchQuery(userText, meta);

    const serp = await serperSearch({
      query,
      country: "us",
      location: zip && /^\d{5}$/.test(zip) ? zip : cityState,
      page: 1,
    });

    // Professional fallback (no crash)
    if (!serp.ok) {
      console.error("SERPER_FAIL:", serp.error);
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "البحث المباشر غير متاح الآن، وما أقدر أعطيك سعر/موقع مؤكد. كبديل سريع: قلّي أي متجر تفضّل (AutoZone / O’Reilly / NAPA) وإذا عندك رقم القطعة Part Number أرسله لي."
            : "Web search isn’t available right now, so I can’t provide confirmed prices/locations. Quick fallback: tell me your preferred store (AutoZone/O’Reilly/NAPA) and share a part number if you have one.",
        search: { ok: false, error: serp.error },
      };
    }

    const results = extractTopResults(serp.data, 6);

    const system =
      `You are FixLens, a professional automotive diagnostic assistant. ` +
      `When using web results, NEVER invent prices or store locations. Only summarize what the results contain. ` +
      (lang === "ar"
        ? `Reply in Arabic. Keep it short and practical.`
        : `Reply in English. Keep it short and practical.`);

    const assistantReply = await openaiChat({
      system,
      messages: [
        {
          role: "user",
          content:
            `Summarize these results for the user. Output 3-6 short lines. ` +
            `Each line: store/site + price if shown (otherwise "price not shown") + address if shown + link.\n\n` +
            `DATA:\n${JSON.stringify({ query, geo: zip || cityState, results })}`,
        },
      ],
      temperature: 0.2,
    });

    return {
      ok: true,
      reply: assistantReply,
      search: { ok: true, query, results },
    };
  }

  // (C) Normal diagnosis/chat
  const system =
    `You are FixLens (Doctor Mechanic style). Use calm, simple "white language". ` +
    `No headings, no bullet lists. Ask only the minimum clarifying questions. Give safe, realistic guidance. ` +
    `If user asks for exact price/location, ask for ZIP/city and use the search tool (handled by server). ` +
    (lang === "ar" ? `Reply in Arabic.` : `Reply in English.`);

  const temp = wantsHowTo ? 0.25 : 0.3;

  const reply = await openaiChat({
    system,
    messages,
    temperature: temp,
  });

  return { ok: true, reply };
}
