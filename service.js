// service.js
import OpenAI from "openai";
import { doctorPrompt } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-5.1";
const MODEL_VISION = process.env.OPENAI_MODEL_VISION || "gpt-5.1";
const MODEL_TRANSCRIBE = process.env.OPENAI_MODEL_TRANSCRIBE || "gpt-4o-mini-transcribe"; // safe default
const MODEL_LANG = process.env.OPENAI_MODEL_LANG || "gpt-4o-mini"; // optional, not required

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

function asDataUrl(imageBuffer, mimeType) {
  const b64 = Buffer.from(imageBuffer).toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

function safeString(v) {
  return String(v || "").trim();
}

/**
 * Decide whether to web search. Keep it conservative.
 * You can tune this anytime.
 */
function shouldSearch(text) {
  const t = text.toLowerCase();
  return (
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("near me") ||
    t.includes("location") ||
    t.includes("where can i") ||
    t.includes("shop") ||
    t.includes("buy") ||
    t.includes("part number") ||
    t.includes("recall") ||
    t.includes("tsb")
  );
}

async function buildSearchContext(userText) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return "";

  if (!shouldSearch(userText)) return "";

  const q = userText.slice(0, 300);
  const r = await webSearchSerper(q, { gl: "us", hl: "en", num: 5 });

  if (!r?.ok || !Array.isArray(r.results) || r.results.length === 0) return "";

  const lines = r.results
    .slice(0, 5)
    .map((x, i) => {
      const title = safeString(x.title);
      const snippet = safeString(x.snippet);
      const link = safeString(x.link);
      return `${i + 1}) ${title}\n${snippet}\n${link}`;
    })
    .join("\n\n");

  return `WEB SEARCH RESULTS (for context only):\n${lines}`;
}

export async function runTextDiagnosis({ text }) {
  const userText = safeString(text);
  const searchContext = await buildSearchContext(userText);

  const system = doctorPrompt({ mode: "text" });

  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: system }],
    },
    {
      role: "user",
      content: [
        ...(searchContext
          ? [{ type: "input_text", text: searchContext }]
          : []),
        { type: "input_text", text: userText },
      ],
    },
  ];

  const resp = await client.responses.create({
    model: MODEL_TEXT,
    input,
  });

  return resp.output_text || "No response generated.";
}

export async function runImageDiagnosis({ text, imageBuffer, mimeType }) {
  const userText = safeString(text);
  const imageUrl = asDataUrl(imageBuffer, mimeType);

  const system = doctorPrompt({ mode: "image" });

  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: system }],
    },
    {
      role: "user",
      content: [
        ...(userText ? [{ type: "input_text", text: userText }] : []),
        {
          type: "input_image",
          image_url: imageUrl,
        },
      ],
    },
  ];

  const resp = await client.responses.create({
    model: MODEL_VISION,
    input,
  });

  return resp.output_text || "No response generated.";
}

export async function runAudioDiagnosis({ audioBuffer }) {
  // 1) Transcribe
  const transcript = await transcribeAudio(audioBuffer);

  // 2) Diagnose using transcript
  const system = doctorPrompt({ mode: "audio" });

  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: system }],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: transcript }],
    },
  ];

  const resp = await client.responses.create({
    model: MODEL_TEXT,
    input,
  });

  return resp.output_text || "No response generated.";
}

async function transcribeAudio(audioBuffer) {
  // Use OpenAI audio transcription
  // NOTE: OpenAI SDK supports file-like objects. We'll create a Blob-like using File via undici.
  // Railway Node typically supports this fine.

  // If your environment has issues with transcription,
  // we can switch to a different approach.

  const { File } = await import("node:buffer");

  const file = new File([audioBuffer], "audio.m4a", { type: "audio/m4a" });

  const tr = await client.audio.transcriptions.create({
    model: MODEL_TRANSCRIBE,
    file,
  });

  const text = safeString(tr.text);
  if (!text) return "No speech detected in the audio.";
  return text;
}
