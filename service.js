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
const MODEL_VISION = process.env.MODEL_VISION || "gpt-4o";

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
// Search intent detection (English-only)
// ------------------------
function isSearchIntent(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // Broader triggers that also work when user writes Arabic but includes brand names
  const tokens = [
    "near me", "nearby", "closest", "where is", "location", "address", "directions",
    "google maps", "maps", "yelp", "shop", "store", "order online",
    "price", "cost", "how much", "part number", "oem", "aftermarket", "recall", "tsb",
    "walmart", "autozone", "o'reilly", "oreilly", "advance auto", "napa",
    "dealership", "service center", "mechanic", "repair shop"
  ];

  if (tokens.some((k) => t.includes(k))) return true;

  // Also if there are coordinates/zip-like patterns or lots of digits with a place word
  if (/\b\d{5}\b/.test(t)) return true;

  return false;
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

async function maybeWebSearch(userText, locale, { gl = "us", num = MAX_SEARCH_RESULTS } = {}) {
  if (!isSearchIntent(userText)) return { ok: true, snippets: [], used: false, error: "" };

  if (!hasSerperKey()) {
    // ✅ No apology. Just mark as not available.
    return { ok: true, snippets: [], used: false, error: "NO_SERPER_API_KEY" };
  }

  const q = safeText(userText);
  if (!q) return { ok: true, snippets: [], used: false, error: "" };

  // ✅ Use locale for hl when possible (keep it simple)
  const hl = normalizeLocale(locale) || "en";

  const res = await webSearchSerper(q, { gl, hl, num });
  if (!res?.ok) return { ok: true, snippets: [], used: true, error: res?.error || "SEARCH_FAILED" };

  const snippets = formatSearchSnippets(res?.results || []);
  return { ok: true, snippets, used: true, error: "" };
}

// ------------------------
// Audio transcription (real)
// ------------------------
async function transcribeAudio({ audioBuffer, audioMime = "audio/mp4" }) {
  if (!OPENAI_KEY) throw new Error("NO_OPENAI_KEY");
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return "";

  const file = await toFile(audioBuffer, "audio.m4a", { type: audioMime });
  const tx = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file,
  });
  return safeText(tx?.text);
}

// ------------------------
// Hard “Doctor Pro” system prompt
// ------------------------
function buildProSystemPrompt(locale) {
  const lang = normalizeLocale(locale);

  return [
    "You are FixLens Doctor Mechanic Pro — a calm, practical second-opinion mechanic for car issues.",
    `You MUST reply in the user's language. languageHint is '${lang}'. Do not switch languages.`,
    "Do NOT be showy. Do NOT lecture. Do NOT mention that you are following rules.",
    "Never give a final diagnosis. Use probability words: likely, common, often.",
    "Limit to at most 3 likely causes.",
    "Include one calm drivability note: safe briefly vs not recommended.",
    "Ask at most ONE short follow-up question if needed.",
    "Format: one professional paragraph, no headings, no bullets, no numbered lists.",
    "Do NOT say: 'I can't', 'I cannot', 'I'm unable', or refuse. If search is unavailable, give practical alternatives instead.",
    "If internal knowledge snippets are present, use them first to reduce cost and improve accuracy.",
    "If search snippets are present, use them to suggest realistic next steps without dumping links.",
  ].join("\n");
}

// ------------------------
// Post-cleaning guard (anti-refusal / anti-apology)
// ------------------------
function softenRefusals(reply, locale) {
  let out = safeText(reply);

  // Remove common refusal patterns without changing meaning too much
  out = out.replace(/i can[’']?t|i cannot|i'm unable to|unable to/gi, "I");
  out = out.replace(/sorry[,!.\s]+/gi, "");

  // If it becomes empty, return a minimal helpful fallback (English-only code; content will still be guided by system)
  if (!out) {
    return "Share the main symptom, when it happens, and any warning light; I’ll narrow it down and tell you the safest next step.";
  }

  return out;
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

  // 1) Internal knowledge
  let knowledgeSnippets = [];
  try {
    knowledgeSnippets = await buildKnowledgeSnippets(userText, { locale: lang });
  } catch {
    knowledgeSnippets = [];
  }
  const knowledgeClamped = clampArray(knowledgeSnippets || [], MAX_KNOWLEDGE_SNIPS);

  // 2) Search (optional)
  const search = await maybeWebSearch(userText, lang, { gl: "us", num: MAX_SEARCH_RESULTS });
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

  // 4) Build unified messages (no system inside doctorPrompt now)
  const doctorMsgs = buildDoctorMessages({
    history,
    locale: lang,
    text: userText,
    knowledgeSnippets: knowledgeClamped,
    searchSnippets: searchSnips,
    hasImage: Boolean(hasImage),
    hasAudio: Boolean(hasAudio),
    audioTranscript: transcript,
  });

  const messages = [
    { role: "system", content: buildProSystemPrompt(lang) },
    ...doctorMsgs,
  ];

  // 5) Call OpenAI
  try {
    const modelToUse = hasImage && imageBuffer ? MODEL_VISION : MODEL_TEXT;

    let completion;
    if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
      const b64 = imageBuffer.toString("base64");
      const mime = imageMime || "image/jpeg";

      // last user message is a string content
      const lastUser = messages[messages.length - 1];
      const userTextBlock = typeof lastUser?.content === "string" ? lastUser.content : userText;

      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 520,
        messages: [
          ...messages.slice(0, -1),
          {
            role: "user",
            content: [
              { type: "text", text: userTextBlock },
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      });
    } else {
      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 520,
        messages,
      });
    }

    let reply = safeText(completion?.choices?.[0]?.message?.content);
    reply = softenRefusals(reply, lang);

    return {
      ok: true,
      reply: reply || "",
      meta: {
        locale: lang,
        used_search: Boolean(search?.used),
        search_error: safeText(search?.error),
        search_snips: searchSnips.length,
        knowledge_snips: knowledgeClamped.length,
        hasImage: Boolean(hasImage),
        hasAudio: Boolean(hasAudio),
        hasTranscript: Boolean(transcript),
        model: modelToUse,
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
    input?.hasImage || (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0)
  );

  const audioBuffer = input?.audioBuffer || null;
  const audioMime = safeText(input?.audioMime || input?.audioType || "audio/mp4");
  const audioTranscript = safeText(input?.audioTranscript || "");
  const hasAudio = Boolean(
    input?.hasAudio || (audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0)
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

  if (!out?.ok) return { ok: false, error: out?.error || "UNKNOWN_ERROR", reply: "", meta: out?.meta || {} };

  return {
    ok: true,
    reply: out.reply,
    transcript: out.transcript || "",
    meta: out.meta || {},
  };
}
