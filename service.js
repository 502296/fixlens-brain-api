// service.js — FixLens Brain API (PRO)
// Robust multi-modal handler (text + image + audio) with fail-soft audio.
// Compatible with your doctorPrompt.js (buildDoctorMessages).

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

/* ------------------------- helpers ------------------------- */

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "1" || s === "true" || s === "yes";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function isArabic(locale, text) {
  if (normalizeLocale(locale) === "ar") return true;
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

function nowISO() {
  return new Date().toISOString();
}

function pickModel(envKey, fallback) {
  const v = safeStr(process.env[envKey]).trim();
  return v || fallback;
}

function extractOutputText(respJson) {
  // Responses API: `output_text` is commonly present.
  if (respJson && typeof respJson.output_text === "string" && respJson.output_text.trim()) {
    return respJson.output_text.trim();
  }

  // Fallback: attempt to find text in output array
  const out = respJson?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_text" && typeof c?.text === "string" && c.text.trim()) {
            return c.text.trim();
          }
        }
      }
    }
  }

  return "";
}

/* ------------------------- OpenAI calls (Responses + Transcribe) ------------------------- */

async function openaiResponses({ model, input, temperature = 0.4, max_output_tokens = 500 }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("NO_OPENAI_API_KEY");

  const body = {
    model,
    input, // IMPORTANT: correct Responses API shape (role + content[])
    temperature,
    max_output_tokens,
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `OpenAI Responses error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.raw = json;
    throw err;
  }
  return json;
}

async function openaiTranscribe({ model, base64, mime = "audio/m4a" }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("NO_OPENAI_API_KEY");

  // OpenAI transcription expects a FILE upload (multipart/form-data).
  // We'll create a Blob/File from base64 and send it.
  const bin = Buffer.from(base64, "base64");

  // choose extension based on mime
  let ext = "m4a";
  if (mime.includes("wav")) ext = "wav";
  else if (mime.includes("mp3")) ext = "mp3";
  else if (mime.includes("webm")) ext = "webm";
  else if (mime.includes("ogg") || mime.includes("oga")) ext = "ogg";
  else if (mime.includes("mp4") || mime.includes("mpeg")) ext = "mp4";
  else if (mime.includes("flac")) ext = "flac";

  const filename = `fixlens_audio.${ext}`;

  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([bin], { type: mime }), filename);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `OpenAI Transcribe error (${r.status})`;
    const err = new Error(msg);
    err.status = r.status;
    err.raw = json;
    throw err;
  }

  const text = safeStr(json?.text).trim();
  return text;
}

/* ------------------------- Search gating ------------------------- */

function wantsNearbyShops(text = "") {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("near me") ||
    t.includes("nearby") ||
    t.includes("closest") ||
    t.includes("shop") ||
    t.includes("mechanic") ||
    t.includes("garage") ||
    /وين.*(ورشة|كراج|ميكانيك)/.test(text) ||
    /(ورشة|كراج|ميكانيكي).*قريب/.test(text)
  );
}

function formatSerperResults(results = []) {
  // doctorPrompt requires EXACTLY 3 options if user asks for shops/addresses.
  const top = Array.isArray(results) ? results.slice(0, 3) : [];
  return top.map((r) => {
    const title = safeStr(r?.title);
    const link = safeStr(r?.link);
    const snippet = safeStr(r?.snippet);
    return `${title}${link ? " — " + link : ""}${snippet ? " — " + snippet : ""}`;
  });
}

/* ------------------------- Main handler ------------------------- */

export async function handleFixLensRequest(payload = {}) {
  const debug = toBool(process.env.FIXLENS_DEBUG);

  // Inputs from Flutter
  const locale = normalizeLocale(payload.locale || payload.language || "en");
  const userText = safeStr(payload.text || payload.message || payload.userText);

  const alreadyAskedIntake = !!payload.alreadyAskedIntake;

  // image can be: { imageBase64, imageMime } or { imageUrl }
  const imageBase64 = safeStr(payload.imageBase64 || "");
  const imageMime = safeStr(payload.imageMime || "image/jpeg");
  const imageUrl = safeStr(payload.imageUrl || "");

  // audio can be: { audioBase64, audioMime }
  const audioBase64 = safeStr(payload.audioBase64 || "");
  const audioMime = safeStr(payload.audioMime || "audio/m4a");

  const hasImage = !!(imageBase64 || imageUrl);
  const hasAudio = !!audioBase64;

  // Models (env)
  // You CAN use GPT-5 here by setting OPENAI_MODEL_TEXT="gpt-5" (or FIXLENS_TEXT_MODEL).
  const MODEL_TEXT = pickModel("OPENAI_MODEL_TEXT", pickModel("FIXLENS_TEXT_MODEL", "gpt-4o-mini"));
  const MODEL_VISION = pickModel("OPENAI_MODEL_VISION", MODEL_TEXT);
  const MODEL_TRANSCRIBE = pickModel("OPENAI_MODEL_TRANSCRIBE", "gpt-4o-mini-transcribe");

  // 1) Knowledge snippets (internal)
  const knowledgeSnippets = buildKnowledgeSnippets(userText, { limit: 6 });

  // 2) Optional web search (only if user asks for shops/addresses)
  let searchSnippets = [];
  if (wantsNearbyShops(userText)) {
    const sr = await webSearchSerper(userText, { gl: "us", hl: locale === "ar" ? "ar" : "en", num: 5 }).catch(() => null);
    const formatted = formatSerperResults(sr?.results || []);
    // Always exactly 3 if asked; if not enough, pad with empty lines
    while (formatted.length < 3) formatted.push("—");
    searchSnippets = formatted.slice(0, 3);
  }

  // 3) Audio transcription (FAIL-SOFT)
  let audioTranscript = "";
  let audioError = "";

  if (hasAudio) {
    try {
      // validate mime list: must be one of supported
      const ok =
        /audio\/(flac|m4a|mp3|mpeg|mp4|mpga|oga|ogg|wav|webm)/i.test(audioMime) ||
        /(flac|m4a|mp3|mpeg|mp4|mpga|oga|ogg|wav|webm)/i.test(audioMime);

      if (!ok) {
        audioError = `Unsupported audioMime: ${audioMime}`;
      } else {
        audioTranscript = await openaiTranscribe({
          model: MODEL_TRANSCRIBE,
          base64: audioBase64,
          mime: audioMime,
        });
      }
    } catch (e) {
      audioError = e?.message || "Audio transcription failed";
      // IMPORTANT: do NOT throw — continue with text/image.
    }
  }

  // 4) Build Doctor messages (system + user) in correct format
  const messages = buildDoctorMessages({
    text: userText,
    knowledgeSnippets,
    searchSnippets,
    hasImage,
    hasAudio,
    audioTranscript,
    alreadyAskedIntake,
    // extraRules (optional) if you want:
    extraRules: "",
  });

  // 5) Build Responses API "input" structure (IMPORTANT: fixes your input_text error)
  // We pass system content + user content, and attach image if exists.
  const userContent = [];

  // Put the user prompt (already includes MODE + rules + knowledge + audio transcript)
  userContent.push({ type: "input_text", text: safeStr(messages[1]?.content) });

  // Attach image if present
  if (hasImage) {
    if (imageUrl) {
      userContent.push({ type: "input_image", image_url: imageUrl });
    } else if (imageBase64) {
      // data URL
      const dataUrl = `data:${imageMime || "image/jpeg"};base64,${imageBase64}`;
      userContent.push({ type: "input_image", image_url: dataUrl });
    }
  }

  // Decide model: vision model if image exists, else text model
  const modelToUse = hasImage ? MODEL_VISION : MODEL_TEXT;

  // 6) Call OpenAI Responses
  let reply = "";
  try {
    const resp = await openaiResponses({
      model: modelToUse,
      input: [
        { role: "system", content: safeStr(messages[0]?.content) },
        { role: "user", content: userContent },
      ],
      temperature: 0.4,
      max_output_tokens: 700,
    });

    reply = extractOutputText(resp);

    if (!reply) {
      // Avoid your “Empty GPT-5 response” crash:
      reply = isArabic(locale, userText)
        ? "صار خطأ بسيط وأنا أحاول أطلع رد… جرّب مرة ثانية بعد لحظة."
        : "A small issue happened while generating a reply. Please try again in a moment.";
    }
  } catch (e) {
    if (debug) {
      console.error("handleFixLensRequest error:", {
        at: nowISO(),
        status: e?.status,
        message: e?.message,
        audioError,
      });
    }

    // Provide a useful response even if OpenAI call fails
    reply = isArabic(locale, userText)
      ? "صار خطأ أثناء التحليل. جرّب مرة ثانية بعد لحظة."
      : "Something went wrong while analyzing. Please try again in a moment.";
  }

  // 7) If audio failed, append a SHORT note (in user's language) WITHOUT breaking main reply
  // (Optional – you can remove this if you don't want any note)
  if (hasAudio && !audioTranscript && audioError) {
    const note = isArabic(locale, userText)
      ? "\n\nملاحظة: الصوت ما انقرأ لأن صيغة الملف غير مدعومة أو فيها مشكلة. جرّب تسجيل m4a (AAC)."
      : "\n\nNote: The audio couldn’t be processed (unsupported/invalid format). Try recording as m4a (AAC).";
    reply += note;
  }

  return {
    ok: true,
    reply,
    meta: {
      locale,
      hasImage,
      hasAudio,
      audioTranscript: !!audioTranscript,
      modelUsed: modelToUse,
    },
  };
}
