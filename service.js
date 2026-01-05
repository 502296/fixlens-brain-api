// service.js
import OpenAI from "openai";
import { toFile } from "openai/uploads";

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js"; // إذا عندك هذا الملف + SERPER_API_KEY

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const DEFAULT_MODEL = process.env.FIXLENS_MODEL || "gpt-4o"; // غيّرها إذا تحب
const MAX_OUTPUT_TOKENS = Number(process.env.FIXLENS_MAX_OUTPUT_TOKENS || 650);
const MAX_TURNS = Number(process.env.FIXLENS_MAX_TURNS || 20); // آخر كم رسالة نحافظ عليها

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function stripDataUrl(b64OrDataUrl) {
  const s = safeStr(b64OrDataUrl);
  const idx = s.indexOf("base64,");
  return idx !== -1 ? s.slice(idx + "base64,".length) : s;
}

function guessImageMimeFromDataUrl(dataUrl) {
  const s = safeStr(dataUrl);
  const m = s.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  return m?.[1] || "image/jpeg";
}

function makeImageDataUrl(b64OrDataUrl) {
  const s = safeStr(b64OrDataUrl);
  if (!s) return null;
  if (s.startsWith("data:image/")) return s;
  // افتراض jpeg إذا ماكو data url
  return `data:image/jpeg;base64,${stripDataUrl(s)}`;
}

async function transcribeAudioIfAny(audio) {
  // audio يمكن يكون:
  // { base64, mimeType } أو string base64
  if (!audio) return "";

  let base64 = "";
  let mimeType = "audio/m4a";

  if (typeof audio === "string") {
    base64 = audio;
  } else if (typeof audio === "object") {
    base64 = audio.base64 || audio.data || "";
    mimeType = audio.mimeType || audio.type || mimeType;
  }

  base64 = safeStr(base64);
  if (!base64) return "";

  const raw = Buffer.from(stripDataUrl(base64), "base64");

  // اسم ملف مناسب حسب النوع
  const ext =
    mimeType.includes("wav") ? "wav" :
    mimeType.includes("mp3") ? "mp3" :
    mimeType.includes("ogg") ? "ogg" :
    mimeType.includes("webm") ? "webm" :
    "m4a";

  const file = await toFile(raw, `voice.${ext}`);

  const tr = await client.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });

  return safeStr(tr.text).trim();
}

function looksLikeSearchIntent(text) {
  const t = safeStr(text).toLowerCase();
  if (!t) return false;
  // كلمات شائعة لنية البحث
  return (
    t.includes("near me") ||
    t.includes("closest") ||
    t.includes("nearby") ||
    t.includes("address") ||
    t.includes("location") ||
    t.includes("find a shop") ||
    t.includes("mechanic shop") ||
    t.includes("كراج") ||
    t.includes("ورشة") ||
    t.includes("قريب مني") ||
    t.includes("اقرب") ||
    t.includes("وين") ||
    t.includes("عنوان")
  );
}

async function tryWebSearch(query, { gl = "us", hl = "en", num = 5 } = {}) {
  // إذا ما عندك SERPER_API_KEY، يرجع فاضي بدون ما يكسر
  try {
    const r = await webSearchSerper(query, { gl, hl, num });
    if (!r?.ok) return { ok: false, results: [] };
    // نبني سطور قصيرة بعناوين + روابط
    const items = (r.results || []).slice(0, num).map((x) => {
      const title = safeStr(x.title);
      const link = safeStr(x.link);
      const snippet = safeStr(x.snippet);
      return { title, link, snippet };
    });
    return { ok: true, results: items };
  } catch {
    return { ok: false, results: [] };
  }
}

function buildInputFromMessages(messages) {
  // messages بصيغة Flutter/Chat: [{role:"user"|"assistant", content:"..."}]
  // نطلعها بصيغة Responses API مع content parts.
  const arr = Array.isArray(messages) ? messages : [];
  const last = arr.slice(-MAX_TURNS);

  return last.map((m) => {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const text = safeStr(m?.content || m?.text || "");
    return {
      role,
      content: text ? [{ type: "input_text", text }] : [{ type: "input_text", text: "" }],
    };
  });
}

function pickBestOutputText(resp) {
  // Responses API يرجع output array
  // نلتقط كل output_text ونجمعه
  try {
    const out = resp?.output || [];
    const chunks = [];
    for (const item of out) {
      const c = item?.content || [];
      for (const part of c) {
        if (part?.type === "output_text" && part?.text) chunks.push(part.text);
      }
    }
    return chunks.join("").trim();
  } catch {
    return "";
  }
}

function openAIErrorToJSON(err) {
  // لا تعتمد على err.status لأن مرات مو موجود
  const status =
    err?.status ||
    err?.response?.status ||
    err?.error?.status ||
    500;

  const message =
    safeStr(err?.message) ||
    safeStr(err?.error?.message) ||
    "Unknown error";

  const code =
    safeStr(err?.code) ||
    safeStr(err?.error?.code) ||
    "";

  const param =
    safeStr(err?.param) ||
    safeStr(err?.error?.param) ||
    "";

  const request_id =
    safeStr(err?.request_id) ||
    safeStr(err?.response?.headers?.["x-request-id"]) ||
    "";

  return { status, message, code, param, request_id };
}

/**
 * handleFixLensRequest(payload)
 * payload متوقع يحتوي:
 * - locale
 * - messages (اختياري) للمحادثة متعددة
 * - text (اختياري) أو userText
 * - image (اختياري) base64 أو dataUrl
 * - images (اختياري) array
 * - audio (اختياري) base64 أو {base64,mimeType}
 */
export async function handleFixLensRequest(payload = {}) {
  const locale = normalizeLocale(payload.locale || payload.language || "en");

  const userText =
    safeStr(payload.text) ||
    safeStr(payload.userText) ||
    safeStr(payload.message) ||
    "";

  // صور
  const images = [];
  if (payload.image) images.push(payload.image);
  if (Array.isArray(payload.images)) images.push(...payload.images);

  // صوت
  const audio = payload.audio || payload.voice || payload.voiceNote || null;

  // History / messages
  const incomingMessages = Array.isArray(payload.messages) ? payload.messages : null;

  try {
    // 1) Knowledge base
    const kb = buildKnowledgeSnippets(userText, { locale });

    // 2) Transcribe audio (إذا موجود)
    let audioTranscript = "";
    if (audio) {
      try {
        audioTranscript = await transcribeAudioIfAny(audio);
      } catch {
        audioTranscript = "";
      }
    }

    // 3) Web search (اختياري) إذا نية بحث
    let webBlock = "";
    if (looksLikeSearchIntent(userText) && process.env.SERPER_API_KEY) {
      const hl = locale === "ar" ? "ar" : "en";
      const gl = "us";
      const sr = await tryWebSearch(userText, { gl, hl, num: 5 });
      if (sr.ok && sr.results.length) {
        const lines = sr.results.map((r, i) => {
          const t = r.title || "Result";
          const l = r.link || "";
          const s = r.snippet || "";
          return `${i + 1}) ${t}\n${l}\n${s}`.trim();
        });
        webBlock = `\n\nWeb results (for reference):\n${lines.join("\n\n")}`;
      }
    }

    // 4) System + user message builder
    const systemPrompt = buildDoctorSystemPrompt({
      locale,
      // نضيف توجيه لتقليل الإطالة + دعم multi-turn
      extraRules: `
Keep replies practical and not overly long.
If the user asks a second question, answer it (multi-turn). Do not freeze after one reply.
Do not repeat the same intake questions every message. Ask at most ONE follow-up question only when truly needed.
`,
    });

    const combinedUser = buildDoctorUserMessage({
      locale,
      text: userText,
      audioTranscript,
      knowledge: kb,
      webBlock,
    });

    // 5) Build Responses input
    const input = [];

    // System message
    input.push({
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }],
    });

    // Conversation history (إن وجد)
    if (incomingMessages && incomingMessages.length) {
      input.push(...buildInputFromMessages(incomingMessages));
      // ونضيف رسالة المستخدم الحالية (إذا مو ضمن messages)
      if (combinedUser) {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: combinedUser }],
        });
      }
    } else {
      // No history: نضيف رسالة المستخدم الحالية مع الصور
      const parts = [];
      if (combinedUser) parts.push({ type: "input_text", text: combinedUser });

      for (const img of images) {
        const dataUrl = makeImageDataUrl(img);
        if (!dataUrl) continue;
        parts.push({
          type: "input_image",
          image_url: { url: dataUrl },
        });
      }

      input.push({ role: "user", content: parts.length ? parts : [{ type: "input_text", text: "" }] });
    }

    // 6) Call OpenAI Responses
    const resp = await client.responses.create({
      model: DEFAULT_MODEL,
      input,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    const reply = pickBestOutputText(resp) || "Sorry — I couldn’t generate a reply this time.";

    return {
      ok: true,
      reply,
      language: locale,
    };
  } catch (err) {
    const e = openAIErrorToJSON(err);

    // رد آمن للمستخدم بدل كسر التطبيق
    const fallback =
      locale === "ar"
        ? "صار خطأ أثناء التحليل. جرّب مرة ثانية بعد لحظة."
        : "Something went wrong while analyzing. Please try again in a moment.";

    return {
      ok: false,
      reply: fallback,
      language: locale,
      error: e,
    };
  }
}
