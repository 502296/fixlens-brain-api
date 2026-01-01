import { buildDoctorPrompt } from "./doctorPrompt.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

function requireKey() {
  if (!OPENAI_API_KEY) {
    const e = new Error("Missing OPENAI_API_KEY");
    e.code = "NO_OPENAI_KEY";
    throw e;
  }
}

function toDataUrl(buffer, mimeType) {
  const b64 = buffer.toString("base64");
  return `data:${mimeType};base64,${b64}`;
}

// --- OpenAI Responses API call (text + image) ---
async function callResponses({ model, input }) {
  requireKey();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input
    })
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error("OPENAI_RESPONSES_ERROR");
    err.status = r.status;
    err.detail = json?.error || json;
    throw err;
  }
  return json;
}

function extractOutputText(respJson) {
  // Responses API can return output_text at top-level in some SDKs,
  // but safest is to concatenate any text segments from output.
  const out = respJson?.output || [];
  let text = "";

  for (const item of out) {
    const content = item?.content || [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        text += c.text;
      }
    }
  }

  // fallback
  if (!text && typeof respJson?.output_text === "string") {
    text = respJson.output_text;
  }
  return (text || "").trim();
}

// --- Whisper transcription (stable) ---
async function transcribeAudio({ audioBuffer, mimeType }) {
  requireKey();

  const form = new FormData();
  // Node 20+ has Blob
  const blob = new Blob([audioBuffer], { type: mimeType || "audio/m4a" });
  form.append("file", blob, "audio");
  form.append("model", "whisper-1");

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error("OPENAI_TRANSCRIBE_ERROR");
    err.status = r.status;
    err.detail = json?.error || json;
    throw err;
  }

  const text = (json?.text || "").toString().trim();
  return text;
}

// ---------------- Public API ----------------

export async function diagnoseText({ text, lang = "auto" }) {
  const system = buildDoctorPrompt({ lang });

  const resp = await callResponses({
    model: "gpt-5.1",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: system }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text }]
      }
    ]
  });

  return {
    text: extractOutputText(resp)
  };
}

export async function diagnoseImage({ imageBuffer, mimeType, lang = "auto", hint = "" }) {
  const system = buildDoctorPrompt({ lang });
  const dataUrl = toDataUrl(imageBuffer, mimeType);

  const userText = hint
    ? `User note: ${hint}`
    : "Analyze the attached photo for visible automotive clues and likely causes. Ask up to 2 short clarifying questions if needed.";

  const resp = await callResponses({
    model: "gpt-5.1",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: system }]
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: userText },
          { type: "input_image", image_url: dataUrl }
        ]
      }
    ]
  });

  return {
    text: extractOutputText(resp)
  };
}

export async function diagnoseAudio({ audioBuffer, mimeType, lang = "auto" }) {
  const transcript = await transcribeAudio({ audioBuffer, mimeType });

  const safeText = transcript
    ? `Audio transcript (user complaint): ${transcript}`
    : "Audio transcript was unclear. Ask one short question to clarify the symptom and when it happens.";

  const out = await diagnoseText({ text: safeText, lang });

  return {
    transcript,
    text: out.text
  };
}
