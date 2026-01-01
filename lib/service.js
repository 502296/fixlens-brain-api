// lib/service.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-5.1"; // أو gpt-4o-mini إذا تريد أرخص
const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
const SERPER_URL = "https://google.serper.dev/search";

// -------------------- Helpers --------------------
function hasArabic(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function pickUserText(body) {
  const t = (body?.message || "").toString().trim();
  if (t) return t;
  // fallback لو عندك messages array
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user" && typeof msgs[i]?.content === "string") {
      return msgs[i].content.trim();
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
  const en = [
    "where can i buy","price","how much","near me","near ","store","buy ","order ",
    "part number","autozone","o'reilly","advance auto","napa","walmart","amazon","ebay",
    "in stock","availability","pickup today","ship","shipping","dealer","dealership"
  ];
  const ar = ["وين","أين","منين","اشتري","سعر","كم","قريب","قريبة مني","محل","متجر","متوفر","اوتوزون","اوريلي","نابا"];
  return en.some(k => t.includes(k)) || ar.some(k => text.includes(k));
}

function isRepairHowToIntent(text = "") {
  const t = text.toLowerCase();
  const en = ["how do i fix","how to replace","step by step","install","remove","replace","repair","swap","bleed brakes"];
  const ar = ["شلون","كيف أصلح","طريقة","خطوة بخطوة","استبدال","تبديل","تركيب","فك","تنظيف"];
  return en.some(k => t.includes(k)) || ar.some(k => text.includes(k));
}

function isHighRiskTopic(text = "") {
  const t = text.toLowerCase();
  const en = ["airbag","srs","brake fluid","bleed brakes","fuel leak","gasoline","high voltage","hybrid battery","ev battery","lift","jack stand"];
  const ar = ["ايرباق","وسائد هوائية","فرامل","سائل الفرامل","بنزين","تسريب","بطارية هايبرد","بطارية كهرب","رافعة","جك"];
  return en.some(k => t.includes(k)) || ar.some(k => text.includes(k));
}

function buildConsentCard(lang, highRisk) {
  if (lang === "ar") {
    return {
      title: highRisk ? "تنبيه سلامة قبل خطوات التصليح" : "موافقة قبل خطوات التصليح",
      body:
        (highRisk ? "الطلب يتضمن إجراء قد يكون خطِرًا (فرامل/وقود/إيرباق/رفع السيارة). " : "") +
        "قبل أن أعطيك خطوات عملية: أنت تعمل على مسؤوليتك، عندك أدوات سلامة (قفازات/نظارات/تثبيت السيارة)، وتتوقف فوراً إذا صار شيء غير آمن أو غير واضح، وتراجع مختص عند الشك.",
      choices: [
        { id: "accept", label: "أوافق وأكمل" },
        { id: "decline", label: "لا، أعطني تشخيص عام فقط" },
      ],
    };
  }
  return {
    title: highRisk ? "Safety confirmation before repair steps" : "Confirmation before repair steps",
    body:
      (highRisk ? "This involves a potentially hazardous procedure (brakes/fuel/airbags/lifting). " : "") +
      "Before I share hands-on steps: you confirm you have proper safety gear/tools and proceed at your own risk, stop if unsure, and consult a professional if anything feels unsafe.",
    choices: [
      { id: "accept", label: "I agree, continue" },
      { id: "decline", label: "No, general diagnosis only" },
    ],
  };
}

// -------------------- OpenAI --------------------
async function openaiChat({ system, messages, temperature = 0.25 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const payload = {
    model: MODEL_TEXT,
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
    throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 300)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// -------------------- Serper Search --------------------
async function serperSearch({ query, gl = "us", location, page = 1 }) {
  if (!SERPER_API_KEY) return { ok: false, error: "SERPER_API_KEY missing" };

  const body = { q: query, gl, page };
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
  const out = [];

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

function buildSearchQuery(userText, meta = {}) {
  const zip = (meta?.zip || "").toString().trim();
  const cityState = (meta?.cityState || "").toString().trim();
  const preferredStore = (meta?.preferredStore || "").toString().trim();

  let geo = "";
  if (/^\d{5}$/.test(zip)) geo = ` near ${zip}`;
  else if (cityState) geo = ` near ${cityState}`;

  let store = preferredStore ? ` ${preferredStore}` : "";
  return `${userText}${store}${geo}`.trim();
}

// -------------------- Main Entry --------------------
export async function handleDiagnose(body) {
  const userText = pickUserText(body);
  const meta = body?.meta || body || {};
  const lang = hasArabic(userText) ? "ar" : "en";

  // 1) Consent gate for DIY
  const wantsHowTo = isRepairHowToIntent(userText);
  const highRisk = wantsHowTo && isHighRiskTopic(userText);
  const consentAccepted = !!meta?.consent?.accepted;

  if (wantsHowTo && !consentAccepted) {
    return {
      ok: true,
      reply: lang === "ar"
        ? "قبل خطوات التصليح العملية، لازم تأكيد سلامة سريع."
        : "Before hands-on repair steps, I need a quick safety confirmation.",
      needs_consent: true,
      consent: { required: true, highRisk, card: buildConsentCard(lang, highRisk) },
    };
  }

  // 2) Search mode
  if (isSearchIntent(userText)) {
    const zip = (meta?.zip || "").toString().trim();
    const cityState = (meta?.cityState || "").toString().trim();
    const hasGeo = /^\d{5}$/.test(zip) || (cityState && cityState.length > 2);

    if (!hasGeo) {
      return {
        ok: true,
        reply: lang === "ar"
          ? "حتى أطلع لك محلات قريبة وأسعار حقيقية من المصادر، أرسل ZIP (5 أرقام) أو المدينة/الولاية."
          : "To find nearby stores and real prices from sources, send your ZIP code (5 digits) or your city/state.",
        needs_zip: true,
      };
    }

    const query = buildSearchQuery(userText, meta);
    const serp = await serperSearch({
      query,
      gl: "us",
      location: /^\d{5}$/.test(zip) ? zip : cityState,
      page: 1,
    });

    // ✅ Fallback (بدون انهيار)
    if (!serp.ok) {
      console.error("SERPER_FAIL:", serp.error);
      return {
        ok: true,
        reply: lang === "ar"
          ? "البحث المباشر تعطل حالياً، وما أگدر أعطي سعر/موقع مؤكد. قلّي تفضّل AutoZone لو O’Reilly لو NAPA؟ وإذا عندك Part Number أرسله وأنا أرتّب لك أفضل خيار."
          : "Web search is temporarily unavailable, so I can’t give confirmed prices/locations. Tell me your preferred store (AutoZone/O’Reilly/NAPA) and share a part number if you have one.",
        search: { ok: false, query, error: serp.error },
      };
    }

    const results = extractTopResults(serp.data, 6);

    // ✅ تلخيص “مصادر + أسعار إذا موجودة” بدون اختراع
    const system = lang === "ar"
      ? "أنت FixLens. استخدم النتائج فقط. لا تخترع أسعار أو توفر. إذا السعر غير موجود اكتب: (السعر غير ظاهر). اذكر الروابط. رد عربي قصير وعملي."
      : "You are FixLens. Use ONLY the provided results. Do not invent prices or availability. If price is missing write: (price not shown). Include links. Keep it short and practical.";

    const assistantReply = await openaiChat({
      system,
      messages: [
        {
          role: "user",
          content:
`Summarize these results into 3–6 lines. Each line:
Name + (price if present else "price not shown") + (address/phone if present) + link.
Do NOT invent anything.

DATA:
${JSON.stringify({ query, geo: zip || cityState, results })}`,
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

  // 3) Diagnosis mode (Doctor Mechanic)
  const system = lang === "ar"
    ? "أنت FixLens Doctor Mechanic. لغة عربية بسيطة وهادئة. بدون عناوين ولا نقاط. اسأل أقل عدد أسئلة. قدّم تشخيص منطقي وخطوات آمنة. إذا طلب سعر/قريب مني اطلب ZIP."
    : "You are FixLens Doctor Mechanic. Calm simple language. No headings/bullets. Ask minimal questions. Give safe realistic guidance. If user asks for local price/near me, ask for ZIP.";

  const reply = await openaiChat({
    system,
    messages: [{ role: "user", content: userText }],
    temperature: 0.3,
  });

  return { ok: true, reply };
}
