// service.js

// FixLens Doctor Mechanic Pro (Search-enabled)

// English-only codebase. Replies in the user's language + dialect inferred from the user's text.



// Imports you already use

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

import { buildDoctorSystemPrompt, buildDoctorUserMessage } from "./doctorPrompt.js";

import { webSearchSerper } from "./lib/search.js";



// OpenAI SDK (Node)

// Make sure you have: npm i openai

import OpenAI from "openai";



const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";

const openai = new OpenAI({ apiKey: OPENAI_KEY });



// Models (override in Railway env if you want)

const MODEL_TEXT = process.env.MODEL_TEXT || "gpt-4o-mini";

const MODEL_VISION = process.env.MODEL_VISION || MODEL_TEXT; // can be same

const MODEL_TRANSCRIBE = process.env.MODEL_TRANSCRIBE || "gpt-4o-mini"; // or "whisper-1" if you use audio transcription endpoint



// Limits / behavior knobs

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

function isSearchIntent(text = "") {

  const t = String(text || "").toLowerCase().trim();

  if (!t) return false;



  // English intent: places / near me

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

    t.includes("junk yard") ||

    t.includes("junkyard") ||

    t.includes("salvage yard") ||

    t.includes("auto salvage") ||

    t.includes("pick-n-pull") ||

    t.includes("pull a part") ||

    t.includes("scrap yard") ||

    t.includes("parts yard");



  // English intent: prices / parts / recalls

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



  // Arabic + Iraqi dialect (light)

  const ar =

    t.includes("وين") ||

    t.includes("وين اكدر") ||

    t.includes("وين أگدر") ||

    t.includes("وين اقدر") ||

    t.includes("وين ألاقي") ||

    t.includes("وين الكه") ||

    t.includes("ألكه") ||

    t.includes("الكه") ||

    t.includes("عنوان") ||

    t.includes("موقع") ||

    t.includes("قريب") ||

    t.includes("بالقرب") ||

    t.includes("بالقريب") ||

    t.includes("سعر") ||

    t.includes("كم سعر") ||

    t.includes("كم يكلف") ||

    t.includes("بحث") ||

    t.includes("سكراب") ||

    t.includes("تشليح") ||

    t.includes("سلفج") ||

    t.includes("جنك يارد") ||

    t.includes("junk yard") ||

    t.includes("salvage");



  return place || commerce || ar;

}



function formatSearchSnippets(results = []) {

  // No bullets/no numbering; each item becomes a short paragraph.

  // Keep it Apple-safe and avoid hallucinating addresses if snippet doesn't confirm.

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



async function maybeWebSearch(userText, { gl = "us", hl = "en", num = MAX_SEARCH_RESULTS } = {}) {

  if (!isSearchIntent(userText)) return { ok: true, snippets: [], used: false };

  if (!hasSerperKey()) {

    console.log("Serper key missing (SERPER_API_KEY not set).");

    return { ok: false, snippets: [], used: false, error: "NO_SERPER_API_KEY" };

  }



  const q = safeText(userText);

  if (!q) return { ok: true, snippets: [], used: false };



  const res = await webSearchSerper(q, { gl, hl, num });

  if (!res?.ok) {

    console.log("Serper search failed:", res?.error || "UNKNOWN_ERROR");

    return { ok: false, snippets: [], used: true, error: res?.error || "SEARCH_FAILED" };

  }



  const snippets = formatSearchSnippets(res?.results || []);

  return { ok: true, snippets, used: true };

}



// ------------------------

// Audio transcription helper (optional)

// ------------------------

// If your pipeline already transcribes elsewhere, you can skip this.

// This implementation supports a "best effort" transcription if you pass audio bytes.

async function transcribeAudioIfNeeded({ audioBuffer, audioMime }) {

  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {

    return "";

  }



  // If you already do transcription in another file, return "" here and keep existing flow.

  // Otherwise, attempt a simple transcription using OpenAI Audio Transcriptions API if available.

  // NOTE: SDK endpoints can differ by version; adjust if your project already has working transcription.

  try {

    // Prefer whisper-1 if you use it

    const useWhisper = (MODEL_TRANSCRIBE || "").toLowerCase().includes("whisper");

    if (useWhisper) {

      const file = new File([audioBuffer], "audio", { type: audioMime || "audio/mpeg" });

      const r = await openai.audio.transcriptions.create({

        model: "whisper-1",

        file,

      });

      return safeText(r?.text);

    }



    // If not whisper, you likely already transcribe in your own flow; return empty.

    return "";

  } catch (e) {

    console.log("Transcription failed:", e?.message || e);

    return "";

  }

}



// ------------------------

// Main brain: build prompt + call OpenAI

// ------------------------

async function runDoctor({

  locale = "en",

  text = "",

  hasImage = false,

  imageBuffer = null,

  imageMime = "",

  hasAudio = false,

  audioBuffer = null,

  audioMime = "",

  audioTranscript = "",

}) {

  if (!OPENAI_KEY) {

    return { ok: false, error: "NO_OPENAI_KEY", reply: "Server is missing OPENAI_API_KEY." };

  }



  const lang = normalizeLocale(locale);

  const userText = safeText(text);



  // 1) Build knowledge snippets (your internal knowledge base)

  let knowledgeSnippets = [];

  try {

    knowledgeSnippets = await buildKnowledgeSnippets(userText, { locale: lang });

  } catch (e) {

    console.log("autoKnowledge failed:", e?.message || e);

    knowledgeSnippets = [];

  }



  // 2) Web search (only when user intent requires it)

  const search = await maybeWebSearch(userText, { gl: "us", hl: "en", num: MAX_SEARCH_RESULTS });

  const searchSnips = clampArray(search?.snippets || [], MAX_SEARCH_SNIPS);



  // 3) Merge snippets: Search first (fresh), then internal knowledge

  const mergedSnips = clampArray(

    [...searchSnips, ...clampArray(knowledgeSnippets || [], MAX_KNOWLEDGE_SNIPS)],

    MAX_KNOWLEDGE_SNIPS

  );



  // 4) Transcription (optional)

  let tr = safeText(audioTranscript);

  if (hasAudio && !tr) {

    const maybeTr = await transcribeAudioIfNeeded({ audioBuffer, audioMime });

    tr = safeText(maybeTr);

  }



  // 5) Build messages

  const system = buildDoctorSystemPrompt({ locale: lang });



  // Add one extra rule: prefer the user's dialect if the user's text is dialectal

  // (Still English-only code; the model will infer dialect from the user's message.)

  const systemPlus =

    system +

    `



Extra language rule:

- Prefer the user's natural dialect and writing style based on the user's message text.

- Do not mix languages unless the user does.`;



  const userMsg = buildDoctorUserMessage({

    locale: lang,

    text: userText,

    knowledgeSnippets: mergedSnips,

    hasImage,

    hasAudio,

    audioTranscript: tr,

  });



  // 6) Prepare OpenAI call (Text-only vs Vision)

  // We'll use Chat Completions for broad compatibility.

  try {

    const messages = [

      { role: "system", content: systemPlus },

      // If image exists, pass it as multi-part content if your SDK supports it.

      // To keep this file compatible, we include image only as base64 data URL if provided.

      // If your current flow handles image separately, you can keep that and set hasImage=true without passing bytes.

    ];



    if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {

      const b64 = imageBuffer.toString("base64");

      const mime = imageMime || "image/jpeg";

      messages.push({

        role: "user",

        content: [

          { type: "text", text: userMsg },

          { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },

        ],

      });

    } else {

      messages.push({ role: "user", content: userMsg });

    }



    const modelToUse = hasImage ? MODEL_VISION : MODEL_TEXT;



    const completion = await openai.chat.completions.create({

      model: modelToUse,

      messages,

      temperature: 0.4,

      // You can tune these safely:

      max_tokens: 700,

    });



    const reply = safeText(completion?.choices?.[0]?.message?.content);



    // If search was used but returned nothing, we do NOT force "I cannot browse" messaging.

    // The prompt already covers fallback. We keep it clean.

    return {

      ok: true,

      reply: reply || "",

      meta: {

        locale: lang,

        used_search: Boolean(search?.used),

        search_ok: Boolean(search?.ok),

        search_error: search?.error || "",

        search_snips: searchSnips.length,

        knowledge_snips: clampArray(knowledgeSnippets || [], MAX_KNOWLEDGE_SNIPS).length,

        merged_snips: mergedSnips.length,

        hasImage: Boolean(hasImage),

        hasAudio: Boolean(hasAudio),

        hasTranscript: Boolean(Boolean(tr)),

        model: modelToUse,

      },

    };

  } catch (e) {

    console.log("OpenAI call failed:", e?.message || e);

    return { ok: false, error: "OPENAI_CALL_FAILED", reply: "" };

  }

}



// ------------------------

// Public API expected by server.js

// ------------------------

// This is a single handler that supports either JSON body or multipart-parsed data.

// Your server.js can call handleFixLens(req) and return its JSON.

export async function handleFixLensRequest(input = {}) {

  const locale = normalizeLocale(input?.locale || "en");

  const text = safeText(input?.text || input?.message || "");



  // Image

  const imageBuffer = input?.imageBuffer || null; // Buffer

  const imageMime = safeText(input?.imageMime || input?.imageType || "");

  const hasImage = Boolean(input?.hasImage || (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0));



  // Audio

  const audioBuffer = input?.audioBuffer || null; // Buffer

  const audioMime = safeText(input?.audioMime || input?.audioType || "");

  const audioTranscript = safeText(input?.audioTranscript || "");

  const hasAudio = Boolean(input?.hasAudio || (audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0));



  // Run doctor

  const out = await runDoctor({

    locale,

    text,

    hasImage,

    imageBuffer,

    imageMime,

    hasAudio,

    audioBuffer,

    audioMime,

    audioTranscript,

  });



  // Standard response shape for Flutter

  if (!out?.ok) {

    return {

      ok: false,

      error: out?.error || "UNKNOWN_ERROR",

      reply: "",

    };

  }



  return {

    ok: true,

    reply: out.reply,

    meta: out.meta || {},

  };

}
