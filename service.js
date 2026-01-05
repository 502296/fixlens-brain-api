// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js"; // <-- returns SYSTEM PROMPT string
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";
import { toFile } from "openai/uploads";

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// Recommended defaults
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
// Search intent detection
// ------------------------
function hasZipLike(text = "") {
  const t = String(text || "");
  return /\b\d{5}\b/.test(t); // US ZIP heuristic
}

function isSearchIntent(text = "") {
  const t = String(text || "").toLowerCase().trim();
  if (!t) return false;

  // English keywords (codebase stays English-only)
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
    t.includes("tire") ||
    t.includes("alignment") ||
    t.includes("midas") ||
    t.includes("discount tire");

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

  // If user provides ZIP, it's often a nearby intent even if they typed in another language.
  return place || commerce || hasZipLike(text);
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
// Audio transcription
// ------------------------
function extFromMime(mime = "") {
  const m = String(mime || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("aac")) return "aac";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("webm")) return "webm";
  return "m4a";
}

function normalizeAudioMime(mime = "") {
  const m = String(mime || "").toLowerCase().trim();
  if (!m) return "audio/mp4";
  if (m === "audio/m4a" || m === "audio/x-m4a") return "audio/mp4";
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
// Build unified USER message text
// ------------------------
function buildUnifiedUserText({
  lang,
  userText,
  knowledgeSnippets = [],
  searchSnippets = [],
  hasImage = false,
  hasAudio = false,
  transcript = "",
} = {}) {
  const parts = [];

  // Hard language pinning (prevents image/audio replies defaulting to English)
  parts.push(`User language: ${lang}`);
  parts.push(`Reply ONLY in ${lang}.`);

  if (userText) {
    parts.push(`USER_MESSAGE:\n${userText}`);
  }

  if (hasAudio) {
    if (transcript) {
      parts.push(`AUDIO_TRANSCRIPT:\n${transcript}`);
    } else {
      parts.push(`AUDIO_NOTE:\nUser attached an audio clip. No transcript available.`);
    }
  }

  if (hasImage) {
    parts.push(`IMAGE_NOTE:\nUser attached an image. Analyze what is visible and use it in your diagnosis.`);
  }

  if (knowledgeSnippets.length) {
    parts.push(`AUTO_KNOWLEDGE:\n${knowledgeSnippets.join("\n\n")}`);
  }

  if (searchSnippets.length) {
    parts.push(`WEB_SEARCH_SNIPPETS:\n${searchSnippets.join("\n\n")}`);
  }

  return parts.join("\n\n");
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

  // 2) Search
  let search = { ok: true, used: false, snippets: [] };
  try {
    search = await maybeWebSearch(userText, {
      gl: "us",
      hl: lang === "ar" ? "ar" : "en",
      num: MAX_SEARCH_RESULTS,
    });
  } catch (e) {
    search = { ok: false, used: false, snippets: [], error: "SEARCH_THROW" };
  }
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

  // 4) Build messages (service-compatible with doctorPrompt.js that returns a SYSTEM PROMPT string)
  const systemPrompt = safeText(buildDoctorMessages()); // <-- STRING
  const unifiedUserText = buildUnifiedUserText({
    lang,
    userText,
    knowledgeSnippets: knowledgeClamped,
    searchSnippets: searchSnips,
    hasImage: Boolean(hasImage),
    hasAudio: Boolean(hasAudio),
    transcript,
  });

  // Optional: include a short portion of history (safe & cheap)
  const historyMsgs = Array.isArray(history)
    ? history
        .slice(-10)
        .map((m) => {
          const role = m?.role === "assistant" ? "assistant" : "user";
          const content = safeText(m?.content || m?.text || "");
          if (!content) return null;
          return { role, content };
        })
        .filter(Boolean)
    : [];

  const baseMessages = [
    { role: "system", content: systemPrompt },
    ...historyMsgs,
  ];

  // 5) Call OpenAI
  try {
    const modelToUse = hasImage && imageBuffer ? MODEL_VISION : MODEL_TEXT;

    let completion;

    if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
      const b64 = imageBuffer.toString("base64");
      const mime = imageMime || "image/jpeg";

      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 700,
        messages: [
          ...baseMessages,
          {
            role: "user",
            content: [
              { type: "text", text: unifiedUserText },
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
            ],
          },
        ],
      });
    } else {
      completion = await openai.chat.completions.create({
        model: modelToUse,
        temperature: 0.35,
        max_tokens: 700,
        messages: [
          ...baseMessages,
          { role: "user", content: unifiedUserText },
        ],
      });
    }

    let reply = safeText(completion?.choices?.[0]?.message?.content);

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
      },
      transcript,
    };
  } catch (err) {
    // IMPORTANT: show real error in logs (so we don't fly blind)
    console.error("OPENAI_CALL_FAILED:");
    console.error(err?.response?.data || err?.message || err);
    return {
      ok: false,
      error: err?.response?.data || err?.message || "OPENAI_CALL_FAILED",
      reply: "",
    };
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
    input?.hasAudio || (audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 2000)
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

  if (!out?.ok) {
    // Return a stable shape; keep detailed error in server logs
    return { ok: false, error: out?.error || "UNKNOWN_ERROR", reply: "" };
  }

  return {
    ok: true,
    reply: out.reply,
    transcript: out.transcript || "",
    meta: out.meta || {},
  };
}
