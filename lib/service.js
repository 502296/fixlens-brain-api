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
    "near ",
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
    "pick up today",
    "pickup today",
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
        (highRisk
          ? "الطلب يتضمن إجراء قد يكون خطِرًا (مثل الفرامل/الوقود/الوسائد الهوائية). "
          : "") +
        "قبل أن أعطيك خطوات عملية: أؤكد أنك تعمل على مسؤوليتك، وأنك تملك أدوات ومعدات سلامة مناسبة، وتوقف فورًا إذا صار خطر أو لم تكن متأكد.",
      choices: [
        { id: "accept", label: "أوافق وأكمل" },
        { id: "decline", label: "لا، أعطني تشخيص عام فقط" },
      ],
    };
  }

  return {
    title: highRisk ? "Safety confirmation before repair steps" : "Confirmation before repair steps",
    body:
      (highRisk ? "Your request involves a potentially hazardous procedure (brakes/fuel/airbags). " : "") +
      "Before I give hands-on steps: you confirm you have proper safety gear/tools and will work at your own risk, stop if unsure, and consult a professional if anything feels unsafe.",
    choices: [
      { id: "accept", label: "I agree, continue" },
      { id: "decline", label: "No, general diagnosis only" },
    ],
  };
}

// ============================
// OpenAI (simple fetch)
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
// Serper Search + Fallback
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

  const store = preferredStore ? ` ${preferredStore}` : "";
  return `${userText}${store}${geo}`.trim();
}

// ============================
// Main handler
// ============================

export async function handleChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const meta = body?.meta || {};
  const userText = pickUserText(messages);
  const lang = hasArabic(userText) ? "ar" : "en";

  // 1) Consent Gate for repair/how-to
  const wantsHowTo = isRepairHowToIntent(userText);
  const highRisk = wantsHowTo && isHighRiskTopic(userText);
  const consentAccepted = !!meta?.consent?.accepted;

  if (wantsHowTo && !consentAccepted) {
    const card = buildConsentCard(lang, highRisk);
    return {
      ok: true,
      needs_consent: true,
      consent: {
        required: true,
        highRisk,
        card,
      },
      reply:
        lang === "ar"
          ? "قبل خطوات التصليح العملية، لازم توافق على تنبيه السلامة السريع."
          : "Before hands-on repair steps, I need a quick safety confirmation.",
    };
  }

  // 2) Search intent
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

    // ✅ Fallback (لا ينهار)
    if (!serp.ok) {
      console.error("SERPER_FAIL:", serp.error);
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "البحث المباشر غير متاح الآن، وما أقدر أعطيك سعر/موقع مؤكد. قلّي تفضّل أي متجر (AutoZone / O’Reilly / NAPA) وإذا عندك Part Number أرسله."
            : "Web search isn’t available right now, so I can’t confirm price/location. Tell me your preferred store (AutoZone/O’Reilly/NAPA) and share a part number if you have one.",
        debug: { search_ok: false },
      };
    }

    const results = extractTopResults(serp.data, 6);

    const system =
      lang === "ar"
        ? `You are FixLens Doctor Mechanic. Reply in Arabic. Use the results only. NEVER invent prices or stores. Keep it short.`
        : `You are FixLens Doctor Mechanic. Reply in English. Use the results only. NEVER invent prices or stores. Keep it short.`;

    const assistantReply = await openaiChat({
      system,
      messages: [
        {
          role: "user",
          content:
            `Summarize these results without inventing anything. Format: 3-6 bullets. Each bullet: store/site + price if shown + address if shown + link. If price is missing say "price not shown".\n\n` +
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

  // 3) Normal diagnosis / chat
  const system =
    lang === "ar"
      ? `You are FixLens Doctor Mechanic (paid, professional). Reply in Arabic only. Use calm simple white language. No headings. No bullet lists. Ask minimum clarifying questions.`
      : `You are FixLens Doctor Mechanic (paid, professional). Reply in English only. Use calm simple white language. No headings. No bullet lists. Ask minimum clarifying questions.`;

  const temperature = wantsHowTo ? 0.25 : 0.3;

  const reply = await openaiChat({
    system,
    messages,
    temperature,
  });

  return { ok: true, reply };
}
