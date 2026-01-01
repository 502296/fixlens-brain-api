// lib/service.js
import { buildDoctorPrompt } from "./doctorPrompt.js";
import { webSearchSerper } from "./search.js";

// --- Config ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// You already store these in Railway:
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-5.1";
const MODEL_VISION = process.env.OPENAI_MODEL_VISION || MODEL_TEXT;
const MODEL_TRANSCRIBE =
  process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe";

function mustKey() {
  if (!OPENAI_API_KEY) {
    const err = new Error("Missing OPENAI_API_KEY");
    err.code = "NO_OPENAI_KEY";
    throw err;
  }
}

function isPriceOrLocationAsk(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("near me") ||
    t.includes("nearest") ||
    t.includes("location") ||
    t.includes("zip") ||
    t.includes("louisville") ||
    t.includes("kentucky")
  );
}

async function openaiResponsesCall({ model, input, max_output_tokens = 900 }) {
  mustKey();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      max_output_tokens,
    }),
  });

  const json = await r.json().catch(() => ({}));

  if (!r.ok) {
    const detail =
      json?.error?.message ||
      json?.message ||
      JSON.stringify(json).slice(0, 600);

    const err = new Error(detail);
    err.http = r.status;
    err.raw = json;
    throw err;
  }

  // Responses API often returns output_text via convenience
  const text = json.output_text || "";
  return { ok: true, text, raw: json };
}

function toDataUrl(buffer, mimeType) {
  const b64 = Buffer.from(buffer).toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

// ---- Public API ----
export async function diagnoseText({ text, history = [], locale = "auto" }) {
  // Optional web search (Serper) when user asks price/location
  let web = null;
  if (process.env.SERPER_API_KEY && isPriceOrLocationAsk(text)) {
    const sr = await webSearchSerper(text, { gl: "us", hl: "en", num: 5 });
    if (sr?.ok) web = sr.results;
  }

  const prompt = buildDoctorPrompt({
    mode: "text",
    userText: text,
    history,
    locale,
    web,
  });

  const input = [
    {
      role: "user",
      content: [
        // IMPORTANT: must be input_text (NOT "text")
        { type: "input_text", text: prompt },
      ],
    },
  ];

  const r = await openaiResponsesCall({
    model: MODEL_TEXT,
    input,
    max_output_tokens: 1100,
  });

  return {
    reply: r.text.trim(),
    meta: { model: MODEL_TEXT, used_web: Boolean(web) },
  };
}

export async function diagnoseImage({
  imageBuffer,
  mimeType,
  text = "",
  locale = "auto",
}) {
  const dataUrl = toDataUrl(imageBuffer, mimeType);

  const prompt = buildDoctorPrompt({
    mode: "image",
    userText: text || "Analyze the attached photo.",
    history: [],
    locale,
    web: null,
  });

  const input = [
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: dataUrl },
      ],
    },
  ];

  const r = await openaiResponsesCall({
    model: MODEL_VISION,
    input,
    max_output_tokens: 1100,
  });

  return {
    reply: r.text.trim(),
    meta: { model: MODEL_VISION },
  };
}

async function transcribeAudio({ audioBuffer, mimeType }) {
  mustKey();

  // Node 18+/20 supports FormData (undici)
  const fd = new FormData();
  fd.append("model", MODEL_TRANSCRIBE);

  // Give a filename that matches mime
  const filename =
    mimeType.includes("wav")
      ? "audio.wav"
      : mimeType.includes("mpeg")
      ? "audio.mp3"
      : "audio.m4a";

  fd.append("file", new Blob([audioBuffer], { type: mimeType }), filename);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: fd,
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail =
      json?.error?.message ||
      json?.message ||
      JSON.stringify(json).slice(0, 600);
    const err = new Error(detail);
    err.http = r.status;
    err.raw = json;
    throw err;
  }

  return (json.text || "").trim();
}

export async function diagnoseAudio({
  audioBuffer,
  mimeType,
  text = "",
  locale = "auto",
}) {
  const transcript = await transcribeAudio({ audioBuffer, mimeType });

  const combined = [
    transcript ? `Audio transcript:\n${transcript}` : "",
    text ? `Extra user note:\n${text}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = await diagnoseText({
    text: combined || "Diagnose based on the audio.",
    history: [],
    locale,
  });

  return {
    reply: out.reply,
    transcript,
    meta: { ...out.meta, transcribe_model: MODEL_TRANSCRIBE },
  };
}
