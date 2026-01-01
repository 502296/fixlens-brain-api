// lib/service.js
import OpenAI from "openai";
import { buildDoctorPrompt } from "./doctorPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Main “brain” model (your choice)
const MAIN_MODEL = process.env.MAIN_MODEL || "gpt-5.1";

// A search-capable model (used only when needed)
const SEARCH_MODEL = process.env.SEARCH_MODEL || "gpt-4o-search-preview";

function safeStr(x, max = 8000) {
  const s = (x ?? "").toString();
  return s.length > max ? s.slice(0, max) : s;
}

function looksLikeRepairHowTo(text = "") {
  const t = text.toLowerCase();
  // simple intent check
  return (
    t.includes("كيف") ||
    t.includes("replace") ||
    t.includes("change") ||
    t.includes("install") ||
    t.includes("remove") ||
    t.includes("تفك") ||
    t.includes("تبديل") ||
    t.includes("تصليح") ||
    t.includes("إصلاح")
  );
}

function isHighRiskTopic(text = "") {
  const t = text.toLowerCase();
  const risky = [
    "airbag",
    "وسادة",
    "srs",
    "fuel",
    "بنزين",
    "brake",
    "فرامل",
    "jack",
    "رافعة",
    "lift",
    "رفع السيارة",
    "high voltage",
    "كهرباء عالية",
    "hybrid battery",
    "بطارية هايبرد",
  ];
  return risky.some((k) => t.includes(k));
}

async function webSearchIfNeeded({ query, preferredLanguage }) {
  // If you don’t want search right now, just return null.
  if (!query) return null;

  // We ask the search model to use web search (tool availability depends on your OpenAI account/models).
  // If tool isn’t available, this will throw; we catch in caller and continue without invented facts.
  const resp = await openai.responses.create({
    model: SEARCH_MODEL,
    input: [
      {
        role: "system",
        content:
          preferredLanguage?.toLowerCase()?.startsWith("ar")
            ? "ابحث على الويب وأعد نتائج واقعية ومختصرة مع أسماء المتاجر/القطع والسعر التقريبي إن وجد."
            : "Search the web and return concise real results with store/part names and approximate prices when available.",
      },
      { role: "user", content: query },
    ],
    // Tool name may differ by account; many setups support a web search tool.
    tools: [{ type: "web_search" }],
  });

  const text = resp.output_text || "";
  return text.trim() ? text.trim() : null;
}

function needBuyingHelp(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("وين") ||
    t.includes("where") ||
    t.includes("buy") ||
    t.includes("price") ||
    t.includes("سعر") ||
    t.includes("اشتري") ||
    t.includes("كم") ||
    t.includes("amazon") ||
    t.includes("autozone") ||
    t.includes("oreilly") ||
    t.includes("advance auto")
  );
}

function toChatHistory(history = []) {
  // history expected: [{role:'user'|'assistant', content:'...'}] OR your custom shape
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    if (!h) continue;
    const role = h.role === "assistant" ? "assistant" : "user";
    const content =
      typeof h.content === "string"
        ? h.content
        : typeof h.text === "string"
        ? h.text
        : "";
    if (!content) continue;
    out.push({ role, content: safeStr(content, 2000) });
  }
  return out.slice(-20);
}

async function runMainModel({ preferredLanguage, message, vehicleInfo, history, safetyConsent }) {
  const system = buildDoctorPrompt({ language: preferredLanguage });

  const userPayload = [
    vehicleInfo ? `Vehicle info: ${safeStr(JSON.stringify(vehicleInfo), 1200)}` : null,
    message ? `User message: ${safeStr(message, 6000)}` : null,
    `safetyConsent: ${safetyConsent ? "true" : "false"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const input = [
    { role: "system", content: system },
    ...toChatHistory(history),
    { role: "user", content: userPayload },
  ];

  const resp = await openai.responses.create({
    model: MAIN_MODEL,
    input,
  });

  return (resp.output_text || "").trim();
}

/** Public: health */
export function getDataHealth() {
  return {
    ok: true,
    mainModel: MAIN_MODEL,
    searchModel: SEARCH_MODEL,
    ts: Date.now(),
  };
}

/** TEXT */
export async function diagnoseText({
  message,
  preferredLanguage = "en",
  vehicleInfo = null,
  history = [],
  mode = "doctor",
  safetyConsent = false,
  requestId,
}) {
  const msg = safeStr(message, 8000);

  if (!msg) {
    return {
      ok: false,
      reply: preferredLanguage.startsWith("ar")
        ? "اكتب وصف مختصر للمشكلة حتى أقدر أساعدك."
        : "Please type a short description of the issue so I can help.",
      language: preferredLanguage,
      requestId,
    };
  }

  // Consent gate for risky repair instructions
  if (looksLikeRepairHowTo(msg) && isHighRiskTopic(msg) && !safetyConsent) {
    return {
      ok: false,
      language: preferredLanguage,
      requestId,
      reply: preferredLanguage.startsWith("ar")
        ? "قبل ما أعطيك خطوات إصلاح تفصيلية، لازم تأكد موافقتك أنك تستخدم معدات سلامة مناسبة وعندك أدوات صحيحة وأنك تتحمّل مسؤولية التنفيذ. إذا موافق اكتب: (أوافق) وسيكمل FixLens."
        : "Before I provide detailed repair steps, please confirm you have proper safety gear, correct tools, and you accept responsibility. If you agree, reply with: “I agree”.",
      needsConsent: true,
    };
  }

  // Buying/search requests
  let searchBlock = "";
  if (needBuyingHelp(msg)) {
    try {
      const q = preferredLanguage.startsWith("ar")
        ? `ابحث عن: ${msg}\nحاول تذكر مدينة/ولاية المستخدم إن ذكرت. أعطِ خيارات شراء مع سعر تقريبي إن وجد.`
        : `Search for: ${msg}\nReturn places to buy and approximate prices when available.`;

      const found = await webSearchIfNeeded({ query: q, preferredLanguage });
      if (found) {
        searchBlock = preferredLanguage.startsWith("ar")
          ? `\n\nنتائج بحث (معلومات واقعية):\n${found}\n\n`
          : `\n\nWeb results (real info):\n${found}\n\n`;
      } else {
        searchBlock = preferredLanguage.startsWith("ar")
          ? "\n\nملاحظة: لم أتمكن من جلب نتائج بحث مؤكدة الآن، لذلك لن أذكر أسعار/أماكن غير مؤكدة.\n\n"
          : "\n\nNote: I couldn't fetch confirmed search results right now, so I won’t guess prices/places.\n\n";
      }
    } catch {
      searchBlock = preferredLanguage.startsWith("ar")
        ? "\n\nملاحظة: البحث غير متاح حالياً، لذلك لن أذكر أسعار/أماكن غير مؤكدة.\n\n"
        : "\n\nNote: Web search is unavailable right now, so I won’t guess prices/places.\n\n";
    }
  }

  const finalMessage = `${msg}${searchBlock}`.trim();

  const reply = await runMainModel({
    preferredLanguage,
    message: finalMessage,
    vehicleInfo,
    history,
    safetyConsent,
  });

  return {
    ok: true,
    reply: reply || (preferredLanguage.startsWith("ar") ? "تم." : "Done."),
    language: preferredLanguage,
    requestId,
  };
}

/** IMAGE */
export async function diagnoseImage({
  message,
  preferredLanguage = "en",
  vehicleInfo = null,
  history = [],
  imageBuffer,
  imageMime,
  mode = "doctor",
  safetyConsent = false,
  requestId,
}) {
  const msg = safeStr(message || "", 4000);

  if (!imageBuffer) {
    return {
      ok: false,
      reply: preferredLanguage.startsWith("ar")
        ? "ما وصلتني الصورة. جرّب مرة ثانية."
        : "I didn’t receive the image. Please try again.",
      language: preferredLanguage,
      requestId,
    };
  }

  // We send image + text to the model (vision-capable model alias must support images in your account).
  // If MAIN_MODEL doesn’t support images, switch MAIN_MODEL for image route via env.
  const system = buildDoctorPrompt({ language: preferredLanguage });

  const input = [
    { role: "system", content: system },
    ...toChatHistory(history),
    {
      role: "user",
      content: [
        { type: "input_text", text: `User message: ${msg || "(no extra text)"}\nsafetyConsent: ${safetyConsent ? "true" : "false"}` },
        {
          type: "input_image",
          image_url: `data:${imageMime || "image/jpeg"};base64,${imageBuffer.toString("base64")}`,
        },
      ],
    },
  ];

  const resp = await openai.responses.create({
    model: MAIN_MODEL,
    input,
  });

  const out = (resp.output_text || "").trim();

  return {
    ok: true,
    reply: out || (preferredLanguage.startsWith("ar") ? "تم." : "Done."),
    language: preferredLanguage,
    requestId,
  };
}

/** AUDIO */
export async function diagnoseAudio({
  message,
  preferredLanguage = "en",
  vehicleInfo = null,
  history = [],
  audioBuffer,
  audioMime,
  audioOriginalName,
  mode = "doctor",
  safetyConsent = false,
  requestId,
}) {
  const msg = safeStr(message || "", 2000);

  // 1) Transcribe first
  let transcript = "";
  try {
    const fileLike = await OpenAI.toFile(audioBuffer, audioOriginalName || "audio.m4a", {
      type: audioMime || "audio/mp4",
    });

    const tr = await openai.audio.transcriptions.create({
      file: fileLike,
      model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    });

    transcript = (tr.text || "").trim();
  } catch (e) {
    return {
      ok: false,
      reply: preferredLanguage.startsWith("ar")
        ? "ما قدرت أقرأ الصوت حالياً. جرّب تسجيل أقصر وبصوت أوضح."
        : "I couldn’t read the audio right now. Please record a shorter, clearer clip.",
      language: preferredLanguage,
      requestId,
      details: e?.message || String(e),
    };
  }

  // 2) Validate transcript (avoid “Thanks for watching” problem)
  const bad = transcript.toLowerCase();
  const looksNonMechanical =
    bad.includes("thanks for watching") ||
    bad.includes("subscribe") ||
    bad.includes("like and") ||
    transcript.length < 8;

  if (looksNonMechanical) {
    return {
      ok: false,
      language: preferredLanguage,
      requestId,
      reply: preferredLanguage.startsWith("ar")
        ? "التسجيل ما طلع بيه صوت ميكانيكي واضح (النص المستخرج غير متعلق بالمحرك). سجّل 8–12 ثانية: تشغيل من وضع طفي، 5 ثواني سلانسيه، ثم دعسة خفيفة، وقرب المايك من مصدر الصوت."
        : "The clip didn’t capture a clear mechanical sound (the transcript looks unrelated). Record 8–12 seconds: start from off, 5 seconds idle, then a light rev, with the mic close to the noise source.",
      needsRetryAudio: true,
      transcript,
    };
  }

  // 3) Optional search for parts/prices if requested
  let searchBlock = "";
  const combinedAsk = `${msg}\nTranscript: ${transcript}`.trim();
  if (needBuyingHelp(combinedAsk)) {
    try {
      const q = preferredLanguage.startsWith("ar")
        ? `ابحث عن القطعة/السعر المرتبط بهذا الوصف:\n${combinedAsk}`
        : `Search for parts/prices related to:\n${combinedAsk}`;

      const found = await webSearchIfNeeded({ query: q, preferredLanguage });
      if (found) {
        searchBlock = preferredLanguage.startsWith("ar")
          ? `\n\nنتائج بحث (معلومات واقعية):\n${found}\n\n`
          : `\n\nWeb results (real info):\n${found}\n\n`;
      }
    } catch {
      // silent: we won't guess
    }
  }

  const finalMessage = `${combinedAsk}${searchBlock}`.trim();

  // 4) Diagnose with main model
  const reply = await runMainModel({
    preferredLanguage,
    message: finalMessage,
    vehicleInfo,
    history,
    safetyConsent,
  });

  return {
    ok: true,
    reply: reply || (preferredLanguage.startsWith("ar") ? "تم." : "Done."),
    language: preferredLanguage,
    requestId,
    transcript,
  };
}
