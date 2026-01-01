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

// ---- intent helpers ----
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
    t.includes("اقرب")
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

// ---- OpenAI Responses API ----
async function callOpenAI({ model, system, userParts }) {
  mustHaveKey();

  const body = {
    model,
    input: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: userParts },
    ],
    // مهم: نخلي الرد JSON صريح
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
  const text = data?.output_text || "";
  return text;
}

// ---- shared pipeline ----
async function runDoctor({ message, preferredLanguage, vehicleInfo, history = [], mode = "doctor", context = {} }) {
  const lang = normalizeLang(preferredLanguage);

  const userText = String(message || "").trim();
  const wantsSearch = looksLikeSearchIntent(userText);
  const wantsHowTo = looksLikeRepairHowToIntent(userText);
  const safetyCritical = isSafetyCritical(userText);

  // Consent gate (server-controlled)
  const repairConsent = context?.repairConsent === true;

  if (wantsHowTo && (safetyCritical || true) && !repairConsent) {
    const reply =
      lang.startsWith("ar")
        ? "قبل ما أعطيك خطوات تصليح، لازم تأكد لي أنك لابس معدات سلامة وعندك أدوات مناسبة (نظارات/قفازات/رافعة آمنة/تثبيت)، وأنك تتحمل المسؤولية. اكتب: (أوافق) إذا موافق."
        : "Before I give repair steps, confirm you have safety gear/tools (gloves/eye protection/safe lift/stands) and accept responsibility. Reply with: “I agree”.";
    return {
      ok: true,
      language: lang,
      reply,
      needsConsent: true,
      needsSearch: false,
      searchQuery: null,
    };
  }

  // If user wants search: do real search and pass results into model
  let searchBlock = null;
  let usedSearch = false;

  if (wantsSearch) {
    const qBase = buildSearchQuery(userText, vehicleInfo);
    const search = await webSearchSerper(qBase, { gl: "us", hl: lang.startsWith("ar") ? "ar" : "en", num: 5 });
    if (search.ok && search.results.length) {
      usedSearch = true;
      searchBlock = {
        query: qBase,
        results: search.results,
      };
    } else {
      // No search available => must not hallucinate
      const reply =
        lang.startsWith("ar")
          ? "حالياً ما أقدر أعمل بحث مباشر عن الأسعار/المتاجر لأن خدمة البحث غير مفعلة على السيرفر. إذا تريد، قلّي مدينتك أو ZIP واسم القطعة وسأرتّب لك ماذا تبحث عنه بالضبط."
          : "I can’t run live price/store search right now because web search isn’t enabled on the server. Share your ZIP/city and the exact part name and I’ll tell you exactly what to search for.";
      return {
        ok: true,
        language: lang,
        reply,
        needsConsent: false,
        needsSearch: true,
        searchQuery: qBase,
      };
    }
  }

  const system = buildDoctorSystemPrompt({ outputLanguage: lang });

  const userPayload = {
    vehicleInfo: vehicleInfo || null,
    mode,
    message: userText,
    history: Array.isArray(history) ? history.slice(-12) : [],
    search: searchBlock,
    constraints: {
      noHallucinatedPrices: true,
      repairConsent: repairConsent === true,
    },
  };

  const raw = await callOpenAI({
    model: TEXT_MODEL,
    system,
    userParts: [{ type: "text", text: JSON.stringify(userPayload) }],
  });

  const parsed = safeJsonParse(raw);
  if (parsed && typeof parsed === "object") {
    // enforce key defaults
    return {
      ok: parsed.ok !== false,
      language: parsed.language || lang,
      reply: parsed.reply || "",
      needsConsent: !!parsed.needsConsent,
      needsSearch: !!parsed.needsSearch,
      searchQuery: parsed.searchQuery || (usedSearch ? searchBlock?.query : null),
    };
  }

  // fallback
  return {
    ok: true,
    language: lang,
    reply: raw || "",
    needsConsent: false,
    needsSearch: false,
    searchQuery: null,
  };
}

function buildSearchQuery(userText, vehicleInfo) {
  const v = vehicleInfo ? JSON.stringify(vehicleInfo) : "";
  // نصنع query مفيد بدون تعقيد
  return `${userText} ${v}`.trim();
}

// ---- public exports ----
export async function diagnoseText({ message, preferredLanguage, vehicleInfo, history, mode, repairConsent }) {
  return runDoctor({
    message,
    preferredLanguage,
    vehicleInfo,
    history,
    mode,
    context: { repairConsent: !!repairConsent },
  });
}

// صورة: نفس منطق النص لكن نمرر صورة للنموذج vision
export async function diagnoseImage({
  message,
  preferredLanguage,
  vehicleInfo,
  history,
  imageBuffer,
  imageMime,
  mode,
  repairConsent,
}) {
  const lang = normalizeLang(preferredLanguage);
  const system = buildDoctorSystemPrompt({ outputLanguage: lang });

  const userPayload = {
    vehicleInfo: vehicleInfo || null,
    mode,
    message: String(message || "").trim(),
    history: Array.isArray(history) ? history.slice(-12) : [],
    constraints: { repairConsent: !!repairConsent, noHallucinatedPrices: true },
  };

  const imageBase64 = imageBuffer.toString("base64");
  const raw = await callOpenAI({
    model: VISION_MODEL,
    system,
    userParts: [
      { type: "text", text: JSON.stringify(userPayload) },
      {
        type: "input_image",
        image_url: `data:${imageMime || "image/jpeg"};base64,${imageBase64}`,
      },
    ],
  });

  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === "object"
    ? { ok: parsed.ok !== false, language: parsed.language || lang, reply: parsed.reply || "", needsConsent: !!parsed.needsConsent, needsSearch: !!parsed.needsSearch, searchQuery: parsed.searchQuery || null }
    : { ok: true, language: lang, reply: raw || "", needsConsent: false, needsSearch: false, searchQuery: null };
}

// صوت: (هنا نفترض أن lib/service.js عندك أصلاً يعمل transcription داخل diagnoseAudio سابقاً)
// إذا تريد، نخليه نص بسيط: نطلب من Flutter إرسال transcript أو نضيف endpoint لاحق.
export async function diagnoseAudio({
  message,
  preferredLanguage,
  vehicleInfo,
  history,
  audioBuffer,
  audioMime,
  audioOriginalName,
  mode,
  repairConsent,
}) {
  // مبدئياً: خلّي الصوت يعتمد على message (transcript) اللي تجيبه من Flutter
  // أو احنا نضيف STT لاحقاً إذا تحب.
  return runDoctor({
    message: String(message || "").trim(),
    preferredLanguage,
    vehicleInfo,
    history,
    mode,
    context: { repairConsent: !!repairConsent },
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
