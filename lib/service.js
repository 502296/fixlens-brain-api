// lib/service.js
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const SERPER_API_KEY = process.env.SERPER_API_KEY || ""; // must be value only
const SERPER_URL = "https://google.serper.dev/search";

// --------------------
// Utils
// --------------------
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

function isAutomotiveDomain(text = "") {
  const t = text.toLowerCase();
  const hints = [
    "car","vehicle","engine","oil","brake","abs","check engine","rpm","stall","misfire",
    "transmission","gear","battery","alternator","starter","fuel","injector","spark",
    "throttle","sensor","o2","camshaft","crankshaft","timing","radiator","coolant",
    "ac","compressor","suspension","strut","control arm","wheel","tire","alignment",
    "toyota","honda","ford","chevy","nissan","bmw","mercedes","hyundai","kia","jeep",
    "autozone","o'reilly","napa","advance auto","dealer",
  ];

  const hintsAr = [
    "سيارة","مركبة","مكينة","محرك","زيت","فرامل","حرارة","ماء الرديتر","رديتر","تبريد",
    "قير","جير","بطارية","دينمو","ستارتر","بنزين","بخاخ","بواجي","كويل","ثروتل","حساس",
    "ABS","RPM","تقطيع","تنتف","يطفى","رجفة","صوت","دعسة","دعس","تسريب",
    "اوتوزون","اوريلي","نابا",
  ];

  return hints.some(k => t.includes(k)) || hintsAr.some(k => text.includes(k));
}

function isSearchIntent(text = "") {
  const t = text.toLowerCase();
  const searchHints = [
    "where can i buy","how much","price","near me","store","buy","order","part number",
    "autozone","o'reilly","advance auto","napa","walmart","amazon","ebay","dealer",
    "availability","in stock","pickup today","shipping","ship"
  ];
  const searchHintsAr = [
    "وين","أين","منين أشتري","اشتري","سعر","كم السعر","وين احصل","قريب","قريبة مني","محل",
    "متجر","متوفر","موجود","اوتوزون","اوريلي","نابا","سعره"
  ];
  return searchHints.some(k => t.includes(k)) || searchHintsAr.some(k => text.includes(k));
}

function isRepairHowToIntent(text = "") {
  const t = text.toLowerCase();
  const howto = [
    "how do i fix","how to replace","step by step","install","remove","repair","replace",
    "swap","bleed brakes","airbag","srs","fuel pump","spark plug","coil","timing belt",
    "timing chain","brake pads","brake caliper","strut","control arm","clean throttle"
  ];
  const howtoAr = [
    "شلون","كيف أصلح","طريقة تصليح","خطوة بخطوة","استبدال","تبديل","تنظيف","تركيب","فك",
    "فرامل","سائل الفرامل","ايرباق","وسائد هوائية","مضخة البنزين","بواجي","كويل","سير","جنزير"
  ];
  return howto.some(k => t.includes(k)) || howtoAr.some(k => text.includes(k));
}

function isHighRiskTopic(text = "") {
  const t = text.toLowerCase();
  const risky = [
    "airbag","srs","brake line","brake fluid","bleed brakes","fuel leak","gasoline",
    "high voltage","hybrid battery","ev battery","steering rack","suspension spring","jack stand"
  ];
  const riskyAr = ["ايرباق","وسائد هوائية","فرامل","سائل الفرامل","بنزين","تسريب","بطارية هايبرد","بطارية كهرب","رافعة"];
  return risky.some(k => t.includes(k)) || riskyAr.some(k => text.includes(k));
}

function buildConsentCard(lang, highRisk) {
  if (lang === "ar") {
    return {
      title: highRisk ? "تنبيه سلامة قبل خطوات التصليح" : "موافقة قبل خطوات التصليح",
      body:
        (highRisk ? "الطلب يتضمن شغلة ممكن تكون خطِرة (فرامل/وقود/ايرباق/رفع السيارة). " : "") +
        "إذا تريد خطوات عملية: أنت تتحمل المسؤولية، وعندك أدوات سلامة مناسبة، وإذا تحس أي خطر توقف وتراجع مختص.",
      choices: [
        { id: "accept", label: "أوافق، أكمل" },
        { id: "decline", label: "لا، تشخيص عام فقط" },
      ],
    };
  }
  return {
    title: highRisk ? "Safety confirmation before repair steps" : "Confirmation before repair steps",
    body:
      (highRisk ? "This involves a potentially hazardous procedure (brakes/fuel/airbags/lifting). " : "") +
      "If you want hands-on steps, you confirm you have proper safety gear/tools, accept responsibility, and will stop if unsure.",
    choices: [
      { id: "accept", label: "I agree, continue" },
      { id: "decline", label: "No, general diagnosis only" },
    ],
  };
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

// --------------------
// Serper
// --------------------
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

    const txt = await resp.text().catch(() => "");
    if (!resp.ok) return { ok: false, error: `Serper HTTP ${resp.status} ${safeTrim(txt, 250)}` };

    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      return { ok: false, error: `Serper non-JSON response: ${safeTrim(txt, 250)}` };
    }
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

// --------------------
// OpenAI (JSON output)
// --------------------
async function openaiJSON({ system, messages, temperature = 0.2 }) {
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

  const txt = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status} ${safeTrim(txt, 300)}`);

  let data;
  try { data = JSON.parse(txt); } catch { throw new Error(`OpenAI non-JSON: ${safeTrim(txt, 200)}`); }

  const raw = data?.choices?.[0]?.message?.content?.trim() || "";

  // parse JSON returned by model
  try {
    const obj = JSON.parse(raw);
    return { ok: true, obj };
  } catch {
    // fallback: return raw as reply
    return { ok: false, obj: { ok: true, reply: raw, needsConsent: false, needsSearch: false, needsZip: false, searchQuery: null } };
  }
}

// --------------------
// Main handler (3.5 stage)
// --------------------
export async function handleChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const meta = body?.meta || {};
  const userText = pickUserText(messages);
  const lang = hasArabic(userText) ? "ar" : "en";

  // Stage 0: Domain Guard (prevents random weight-loss answers)
  if (userText && !isAutomotiveDomain(userText) && userText.length > 2) {
    const reply =
      lang === "ar"
        ? "أنا FixLens مختص بالسيارات والمكائن/الأدوات. اكتبلي سنة السيارة + الموديل + الأعراض ومتى تصير المشكلة، وأنا أساعدك."
        : "FixLens is focused on cars and mechanical tools/machines. Share your car year + make/model + symptoms and when it happens, and I’ll help.";
    return { ok: true, reply, domain: "automotive_only" };
  }

  // Stage 1: Consent Gate for repair/how-to
  const wantsHowTo = isRepairHowToIntent(userText);
  const highRisk = wantsHowTo && isHighRiskTopic(userText);
  const consentAccepted = !!meta?.consent?.accepted;

  if (wantsHowTo && !consentAccepted) {
    const card = buildConsentCard(lang, highRisk);
    return {
      ok: true,
      reply:
        lang === "ar"
          ? "قبل ما أعطيك خطوات عملية، لازم تأكدلي تنبيه السلامة."
          : "Before I give hands-on steps, I need a quick safety confirmation.",
      needs_consent: true,
      consent: { required: true, highRisk, card },
    };
  }

  // Stage 2: Search (Serper) if user asked to buy/price/near me
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
            : "To find nearby stores and real prices, send your ZIP (5 digits) or your city/state.",
        needs_zip: true,
      };
    }

    const query = buildSearchQuery(userText, meta);
    const location = zip && /^\d{5}$/.test(zip) ? zip : cityState;

    const serp = await serperSearch({ query, country: "us", location, page: 1 });

    if (!serp.ok) {
      console.error("SERPER_FAIL:", serp.error);
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "البحث المباشر تعطل حالياً. كحل سريع: قُلّي تفضّل AutoZone أو O’Reilly أو NAPA؟ وإذا عندك Part Number أرسله."
            : "Web search is temporarily unavailable. Quick fallback: which store do you prefer (AutoZone/O’Reilly/NAPA)? If you have a part number, send it.",
        search: { ok: false, error: serp.error },
      };
    }

    const results = extractTopResults(serp.data, 6);

    // Stage 3: Summarize results with strict anti-hallucination
    const system = buildDoctorSystemPrompt({ outputLanguage: lang });

    const { obj } = await openaiJSON({
      system,
      messages: [
        {
          role: "user",
          content:
            "You have search results below. Return JSON ONLY per the schema. " +
            "Set needsSearch=false because results are provided. " +
            "In reply: one short paragraph, include 2–4 best options. Mention price only if explicitly shown; otherwise say price not shown. Do NOT add any other info.\n\n" +
            `SEARCH_QUERY: ${query}\n` +
            `ZIP/CITY: ${location}\n` +
            `RESULTS_JSON: ${JSON.stringify(results)}\n`,
        },
      ],
      temperature: 0.1,
    });

    return {
      ok: true,
      reply: obj?.reply || (lang === "ar" ? "تم." : "Done."),
      search: { ok: true, query, results },
    };
  }

  // Stage 3: Normal diagnosis (Doctor Mechanic style, JSON prompt)
  const system = buildDoctorSystemPrompt({ outputLanguage: lang });

  const { obj } = await openaiJSON({
    system,
    messages,
    temperature: wantsHowTo ? 0.2 : 0.3,
  });

  // Make sure we always return a clean "reply" string
  const reply = typeof obj?.reply === "string" && obj.reply.trim()
    ? obj.reply.trim()
    : (lang === "ar" ? "اكتبلي تفاصيل أكثر حتى أشخصها بدقة." : "Share a bit more detail so I can diagnose accurately.");

  return { ok: true, reply };
}
