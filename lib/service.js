// lib/service.js
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { webSearchSerper } from "./search.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TEXT_MODEL = process.env.FIXLENS_TEXT_MODEL || "gpt-5.1";
const VISION_MODEL = process.env.FIXLENS_VISION_MODEL || "gpt-4o";
const AUDIO_MODEL = process.env.FIXLENS_AUDIO_MODEL || "gpt-4o";

function mustHaveKey() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function normalizeLang(code) {
  if (!code) return "en";
  const c = String(code).trim().toLowerCase();
  if (!c || c === "auto") return "en";
  return c;
}

function looksLikeSearchIntent(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("where can i buy") ||
    t.includes("where to buy") ||
    t.includes("price") ||
    t.includes("how much") ||
    t.includes("link") ||
    t.includes("near me") ||
    t.includes("amazon") ||
    t.includes("autozone") ||
    t.includes("oreilly") ||
    t.includes("walmart") ||
    t.includes("ebay") ||
    t.includes("part number") ||
    t.includes("sku") ||
    t.includes("اين") ||
    t.includes("وين") ||
    t.includes("سعر") ||
    t.includes("رابط") ||
    t.includes("اقرب") ||
    t.includes("أقرب")
  );
}

function looksLikeRepairHowToIntent(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("how to") ||
    t.includes("replace") ||
    t.includes("remove") ||
    t.includes("install") ||
    t.includes("step") ||
    t.includes("diy") ||
    t.includes("fix it") ||
    t.includes("change") ||
    t.includes("بدل") ||
    t.includes("غير") ||
    t.includes("شلون") ||
    t.includes("طريقة") ||
    t.includes("افك") ||
    t.includes("اصلح")
  );
}

function isSafetyCritical(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("airbag") ||
    t.includes("srs") ||
    t.includes("brake") ||
    t.includes("fuel leak") ||
    t.includes("gas leak") ||
    t.includes("high voltage") ||
    t.includes("hybrid battery") ||
    t.includes("jack stands") ||
    t.includes("وسائد") ||
    t.includes("ايرباق") ||
    t.includes("فرامل") ||
    t.includes("بنزين") ||
    t.includes("تهريب")
  );
}

function containsZip(text = "") {
  // US ZIP basic
  return /\b\d{5}(?:-\d{4})?\b/.test(text);
}

function formatSources(results = []) {
  // short, readable, no markdown links requirement, just plain
  const top = results.slice(0, 4);
  if (!top.length) return "";
  const lines = top.map((r, i) => `${i + 1}) ${r.title}\n${r.link}`);
  return `\n\nSources:\n${lines.join("\n\n")}`;
}

async function callOpenAI({ model, system, userParts }) {
  mustHaveKey();

  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: userParts },
    ],
    response_format: { type: "json_object" },
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${r.status}: ${t}`);
  }

  const data = await r.json();
  return data?.output_text || "";
}

function buildSearchQuery(userText, vehicleInfo, userZip) {
  const v = vehicleInfo ? JSON.stringify(vehicleInfo) : "";
  const z = userZip ? `ZIP ${userZip}` : "";
  return `${userText} ${v} ${z}`.trim();
}

async function runDoctor({
  message,
  preferredLanguage,
  vehicleInfo,
  history = [],
  mode = "doctor",
  context = {},
}) {
  const lang = normalizeLang(preferredLanguage);
  const userText = String(message || "").trim();

  const wantsSearch = looksLikeSearchIntent(userText);
  const wantsHowTo = looksLikeRepairHowToIntent(userText);
  const safetyCritical = isSafetyCritical(userText);

  const repairConsent = context?.repairConsent === true;
  const showSources = context?.showSources === true;
  const userZip = context?.userZip ? String(context.userZip).trim() : "";

  // ---- Consent gate ----
  if (wantsHowTo && !repairConsent) {
    const reply =
      lang.startsWith("ar")
        ? "قبل ما أعطيك خطوات تصليح، لازم تأكد لي أنك لابس معدات سلامة وعندك أدوات مناسبة وتتحمل المسؤولية. اكتب: (أوافق) إذا موافق."
        : "Before I give repair steps, confirm you have safety gear/tools and accept responsibility. Reply with: “I agree”.";
    return { ok: true, language: lang, reply, needsConsent: true, needsSearch: false, needsZip: false, searchQuery: null };
  }

  // ---- ZIP gate (Stage 3.5) ----
  // نطلب ZIP فقط عند search intent + لا يوجد zip لا في النص ولا في context
  const zipPresent = !!userZip || containsZip(userText);
  if (wantsSearch && !zipPresent) {
    const reply =
      lang.startsWith("ar")
        ? "حتى أطلع لك أقرب أماكن شراء وسعر تقريبي من مصادر حقيقية، أرسل ZIP code (خمسة أرقام) أو اسم المدينة/الولاية."
        : "To find nearby stores and real prices from sources, send your ZIP code (5 digits) or your city/state.";
    return { ok: true, language: lang, reply, needsConsent: false, needsSearch: true, needsZip: true, searchQuery: buildSearchQuery(userText, vehicleInfo, "") };
  }

  // ---- Search execution ----
  let searchBlock = null;
  let usedSearch = false;
  let searchResults = [];

  if (wantsSearch) {
    const q = buildSearchQuery(userText, vehicleInfo, userZip || (containsZip(userText) ? userText.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] : ""));
    const search = await webSearchSerper(q, { gl: "us", hl: lang.startsWith("ar") ? "ar" : "en", num: 5 });

    if (search.ok && search.results.length) {
      usedSearch = true;
      searchResults = search.results;
      searchBlock = { query: q, results: search.results };
    } else {
      const reply =
        lang.startsWith("ar")
          ? "حالياً خدمة البحث غير متاحة على السيرفر، لذلك ما أقدر أعطيك أسعار/أماكن مؤكدة بدون مصادر. جرّب لاحقاً أو أعطني اسم متجر تفضله."
          : "Web search isn’t available on the server right now, so I can’t provide confirmed prices/locations. Try again later or tell me your preferred store.";
      return { ok: true, language: lang, reply, needsConsent: false, needsSearch: true, needsZip: false, searchQuery: q };
    }
  }

  const system = buildDoctorSystemPrompt({ outputLanguage: lang });

  const userPayload = {
    vehicleInfo: vehicleInfo || null,
    mode,
    message: userText,
    history: Array.isArray(history) ? history.slice(-12) : [],
    search: searchBlock,
    ui: { showSources },
    constraints: {
      noHallucinatedPrices: true,
      repairConsent,
      safetyCriticalHint: safetyCritical,
    },
  };

  const raw = await callOpenAI({
    model: TEXT_MODEL,
    system,
    userParts: [{ type: "text", text: JSON.stringify(userPayload) }],
  });

  const parsed = safeJsonParse(raw);

  let out = parsed && typeof parsed === "object"
    ? {
        ok: parsed.ok !== false,
        language: parsed.language || lang,
        reply: parsed.reply || "",
        needsConsent: !!parsed.needsConsent,
        needsSearch: !!parsed.needsSearch,
        needsZip: !!parsed.needsZip,
        searchQuery: parsed.searchQuery || (usedSearch ? searchBlock?.query : null),
      }
    : { ok: true, language: lang, reply: raw || "", needsConsent: false, needsSearch: false, needsZip: false, searchQuery: usedSearch ? searchBlock?.query : null };

  // Append sources only if showSources=true AND we used search
  if (showSources && usedSearch) {
    out.reply = `${out.reply}${formatSources(searchResults)}`;
  }

  return out;
}

// ---- exports ----
export async function diagnoseText({ message, preferredLanguage, vehicleInfo, history, mode, repairConsent, showSources, userZip }) {
  return runDoctor({
    message,
    preferredLanguage,
    vehicleInfo,
    history,
    mode,
    context: { repairConsent: !!repairConsent, showSources: !!showSources, userZip },
  });
}

export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  history,
  imageBuffer,
  imageMime,
  mode,
  repairConsent,
  showSources,
  userZip,
}) {
  const lang = normalizeLang(preferredLanguage);
  const system = buildDoctorSystemPrompt({ outputLanguage: lang });

  const userPayload = {
    vehicleInfo: vehicleInfo || null,
    mode,
    message: String(message || "").trim(),
    history: Array.isArray(history) ? history.slice(-12) : [],
    ui: { showSources: !!showSources },
    constraints: { repairConsent: !!repairConsent, noHallucinatedPrices: true },
  };

  const imageBase64 = imageBuffer.toString("base64");

  const raw = await callOpenAI({
    model: VISION_MODEL,
    system,
    userParts: [
      { type: "text", text: JSON.stringify(userPayload) },
      { type: "input_image", image_url: `data:${imageMime || "image/jpeg"};base64,${imageBase64}` },
    ],
  });

  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === "object"
    ? { ok: parsed.ok !== false, language: parsed.language || lang, reply: parsed.reply || "", needsConsent: !!parsed.needsConsent, needsSearch: !!parsed.needsSearch, needsZip: !!parsed.needsZip, searchQuery: parsed.searchQuery || null }
    : { ok: true, language: lang, reply: raw || "", needsConsent: false, needsSearch: false, needsZip: false, searchQuery: null };
}

export async function diagnoseAudio({ message, preferredLanguage, vehicleInfo, history, mode, repairConsent, showSources, userZip }) {
  return runDoctor({
    message: String(message || "").trim(),
    preferredLanguage,
    vehicleInfo,
    history,
    mode,
    context: { repairConsent: !!repairConsent, showSources: !!showSources, userZip },
  });
}

export function getDataHealth() {
  return {
    ok: true,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
    hasSerperKey: !!process.env.SERPER_API_KEY,
    textModel: TEXT_MODEL,
    visionModel: VISION_MODEL,
    audioModel: AUDIO_MODEL,
  };
}
