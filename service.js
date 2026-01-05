// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ✅ Recommended defaults
const MODEL_TEXT = process.env.MODEL_TEXT || "gpt-4o-mini";
const MODEL_VISION = process.env.MODEL_VISION || "gpt-4o"; // better on images

const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

function safeText(s) {
  return String(s || "").trim();
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, Math.max(0, max));
}

function hasSerperKey() {
  return Boolean(process.env.SERPER_API_KEY);
}

// ------------------------
// Search intent detection
// ------------------------
// English-only keyword set.
function isSearchIntent(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  const place =
    t.includes("near me") ||
    t.includes("nearby") ||
    t.includes("closest") ||
    t.includes("where is") ||
    t.includes("location") ||
    t.includes("address") ||
    t.includes("directions") ||
    t.includes("google maps") ||
    t.includes("maps") ||
    t.includes("yelp") ||
    t.includes("shop near") ||
    t.includes("repair shop") ||
    t.includes("mechanic") ||
    t.includes("dealer") ||
    t.includes("service center") ||
    t.includes("junk yard") ||
    t.includes("junkyard") ||
    t.includes("salvage yard") ||
    t.includes("auto salvage") ||
    t.includes("pick-n-pull") ||
    t.includes("pull a part") ||
    t.includes("scrap yard") ||
    t.includes("parts yard");

  const commerce =
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("how much") ||
    t.includes("part number") ||
    t.includes("oem") ||
    t.includes("aftermarket") ||
    t.includes("recall") ||
    t.includes("tsb") ||
    t.includes("service bulletin") ||
    t.includes("where can i buy") ||
    t.includes("where to buy") ||
    t.includes("where can i find") ||
    t.includes("where to find") ||
    t.includes("shop") ||
    t.includes("store") ||
    t.includes("order online");

  return place || commerce;
}

function formatSearchSnippets(results = []) {
  return (results || [])
    .slice(0, MAX_SEARCH_SNIPS)
    .map((r) => {
      const title = safeText(r?.title);
      const link = safeText(r?.link);
      const snippet = safeText(r?.snippet);

      const chunks = [];
      if (title) chunks.push(title);
      if (snippet) chunks.push(snippet);
      if (link) chunks.push(`Source: ${link}`);
      return chunks.filter(Boolean).join("\n");
    })
    .filter(Boolean);
}

async function maybeWebSearch(
  userText,
  { gl = "us", hl = "en", num = MAX_SEARCH_RESULTS } = {}
) {
  if (!isSearchIntent(userText)) return { ok: true, snippets: [], used: false };
  if (!hasSerperKey())
    return { ok: false, snippets: [], used: false, error: "NO_SERPER_API_KEY" };

  const q = safeText(userText);
  if (!q) return { ok: true, snippets: [], used: false };

  const res = await webSearchSerper(q, { gl, hl, num });
  if (!res?.ok)
    return {
      ok: false,
      snippets: [],
      used: true,
      error: res?.error || "SEARCH_FAILED",
    };

  const snippets = formatSearchSnippets(res?.results || []);
  return { ok: true, snippets, used: true };
}

// ------------------------
// Audio transcription (ROBUST)
// ------------------------
function extFromMime(mime = "") {
  const m = String(mime || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("aac")) return "aac";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  // audio/mp4, audio/m4a, audio/x-m4a, audio/caf -> treat as m4a
  return "m4a";
}

function normalizeAudioMime(mime = "") {
  const m = String(mime || "").toLowerCase().trim();
  if (!m) return "audio/mp4";
  // iOS sometimes gives audio/x-m4a or audio/m4a
  if (m === "audio/m4a" || m === "audio/x-m4a") return "audio/mp4";
  // caf isn't accepted directly by Whisper; upload as mp4 container
  if (m.includes("caf")) return "audio/mp4";
  return m;
}

async function transcribeAudio({ audioBuffer, audioMime = "audio/mp4" }) {
  if (!OPENAI_KEY) throw new Error("NO_OPENAI_KEY");
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length < 2000)
    return "";

  const mime = normalizeAudioMime(audioMime);
  const ext = extFromMime(mime);
  const filename = `audio.${ext}`;

  const file = await toFile(audioBuffer, filename, { type: mime });

  const tx = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
    response_format: "json",
  });

  return safeText(tx?.text);
}

// ------------------------
// FIXLENS PRO System Prompt (format + language hard clamp)
// ------------------------
function buildProSystemPrompt(lang) {
  // English-only code. The model will answer in the user's language via instructions.
  return [
    "You are FixLens Doctor Mechanic Pro — a calm, practical second-opinion mechanic.",
    "HARD RULE: Reply fully in the user's language. Never mix languages.",
    "Be professional, calm, and practical. Not dramatic. Not medical.",
    "Never give a final/absolute diagnosis; use probability language (likely/common/often).",
    "Provide at most 3 likely causes, ranked.",
    'Always include a clearly labeled line: "Safe to drive?" with Yes/No + short reason + rule (short trip ok / avoid driving).',
    "Give a practical next-step plan (3–6 steps) including ONE discriminating check.",
    "Ask at most ONE follow-up question, only if it truly changes the next step.",
    "If the user asks for shops/addresses, use search snippets and provide EXACTLY 3 options formatted: Name — Address — (optional phone/website). Do not refuse.",
    "Output format must be numbered and structured, not a single paragraph.",
  ].join("\n");
}

// ------------------------
// Main doctor runner
// ------------------------
async function runDoctor({
  locale = "en",
  text = "",
  history = [],
  hasImage = false,
  imageBuffer = null,
  imageMime = "image/jpeg",
  hasAudio = false,
  audioBuffer = null,
  audioMime = "audio/mp4",
  audioTranscript = "",
} = {}) {
  if (!OPENAI_KEY) return { ok: false, error: "NO_OPENAI_KEY", reply: "" };

  const lang = normalizeLocale(locale);
  const userText = safeText(text);

  // 0) Session flag: did we already ask intake once?
  const alreadyAskedIntake = Array.isArray(history)
    ? history.some(
        (m) =>
          typeof m?.content === "string" &&
          m.content.includes("[INTAKE_ALREADY_ASKED]")
      )
    : false;

  // 1) Internal knowledge
  let knowledgeSnippets = [];
  try {
    knowledgeSnippets = await buildKnowledgeSnippets(userText, { locale: lang });
  } catch {
    knowledgeSnippets = [];
  }
  const knowledgeClamped = clampArray(
    knowledgeSnippets || [],
    MAX_KNOWLEDGE_SNIPS
  );

  // 2) Search
  const search = await maybeWebSearch(userText, {
    gl: "us",
    hl: "en",
    num: MAX_SEARCH_RESULTS,
  });
  const searchSnips = clampArray(search?.snippets || [], MAX_SEARCH_SNIPS);

  // 3) Transcribe audio if needed
  let transcript = safeText(audioTranscript);
  if (hasAudio && !transcript && audioBuffer) {
    try {
      transcript = await transcribeAudio({ audioBuffer, audioMime });
    } catch {
      transcript = "";
    }
  }

  // 🔒 Language hard-hint (prevents mixed language especially in multimodal)
  const languageHint =
    lang === "ar"
      ? "IMPORTANT: Respond fully in Arabic only. Do not use English words or headings."
      : `IMPORTANT: Respond fully in ${lang}. Do not switch languages.`;

  // 4) Build unified messages (doctorPrompt handles structure + intake logic)
  const messagesFromPrompt = buildDoctorMessages({
    history,
    locale: lang,
    text: userText,
    knowledgeSnippets: knowledgeClamped,
    searchSnippets: searchSnips,
    hasImage: Boolean(hasImage),
    hasAudio: Boolean(hasAudio),
    audioTranscript: transcript,
    alreadyAskedIntake,
  });

  // ✅ Inject our hard system prompt first
  const messages = [
    { role: "system", content: buildProSystemPrompt(lang) },
    { role: "system", content: languageHint },
    ...messagesFromPrompt,
  ];

  // 5) Call OpenAI (Vision if image exists)
  try {
    const modelToUse = hasImage && imageBuffer ? MODEL_VISION : MODEL_TEXT;

    let completion;
    if (
      hasImage &&
      imageBuffer &&
      Buffer.isBuffer(imageBuffer) &&
      imageBuffer.length > 0
    ) {
      const b64 = imageBuffer.toString("base64");
      const mime = imageMime || "image/jpeg";

      const lastUser = messages[messages.length - 1];
      const userTextBlock =
        typeof lastUser?.content === "string" ? lastUser.content : userText;

      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 700,
        messages: [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: [
              { type: "text", text: userTextBlock },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${b64}` },
              },
            ],
          },
        ],
      });
    } else {
      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 700,
        messages,
      });
    }

    let reply = safeText(completion?.choices?.[0]?.message?.content);

    // ✅ extra guard: remove "I can't" style if it slips
    if (/i can[’']?t|i cannot|unable to/i.test(reply)) {
      reply = reply.replace(/i can[’']?t|i cannot|unable to/gi, "I");
    }

    // ✅ Mark intake as asked ONCE if the assistant asked it now
    // (This prevents repeating the same intake question in every message.)
    const askedIntakeNow =
      /\b(year|make|model)\b/i.test(reply) ||
      /when does it happen/i.test(reply) ||
      /idle|accelerat|brak|turn|bump|highway/i.test(reply) ||
      /سنة|موديل|طراز|متى يحدث|متى يصير|وقت ما يصير/i.test(reply);

    if (askedIntakeNow && !alreadyAskedIntake) {
      reply = `${reply}\n\n[INTAKE_ALREADY_ASKED]`;
    }

    return {
      ok: true,
      reply: reply || "",
      meta: {
        locale: lang,
        used_search: Boolean(search?.used),
        search_ok: Boolean(search?.ok),
        search_error: search?.error || "",
        search_snips: searchSnips.length,
        knowledge_snips: knowledgeClamped.length,
        hasImage: Boolean(hasImage),
        hasAudio: Boolean(hasAudio),
        hasTranscript: Boolean(transcript),
        model: modelToUse,
        alreadyAskedIntake: Boolean(alreadyAskedIntake),
      },
      transcript,
    };
  } catch {
    return { ok: false, error: "OPENAI_CALL_FAILED", reply: "" };
  }
}

export async function handleFixLensRequest(input = {}) {
  const locale = normalizeLocale(input?.locale || "en");
  const text = safeText(input?.text || input?.message || "");
  const history = Array.isArray(input?.history) ? input.history : [];

  const imageBuffer = input?.imageBuffer || null;
  const imageMime = safeText(input?.imageMime || input?.imageType || "image/jpeg");
  const hasImage = Boolean(
    input?.hasImage ||
      (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0)
  );

  const audioBuffer = input?.audioBuffer || null;
  const audioMime = safeText(input?.audioMime || input?.audioType || "audio/mp4");
  const audioTranscript = safeText(input?.audioTranscript || "");
  const hasAudio = Boolean(
    input?.hasAudio ||
      (audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000)
  );

  const out = await runDoctor({
    locale,
    text,
    history,
    hasImage,
    imageBuffer,
    imageMime,
    hasAudio,
    audioBuffer,
    audioMime,
    audioTranscript,
  });

  if (!out?.ok) return { ok: false, error: out?.error || "UNKNOWN_ERROR", reply: "" };

  return {
    ok: true,
    reply: out.reply,
    transcript: out.transcript || "",
    meta: out.meta || {},
  };
}
