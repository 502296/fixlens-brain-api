// service.js
// FixLens Brain API — robust multimodal handler (text + image + audio)
// Works with OpenAI Responses API payload format.

import fs from "fs";
import os from "os";
import path from "path";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-5.2-chat-latest";

function isArabicText(s = "") {
  return /[\u0600-\u06FF]/.test(String(s));
}

function normalizeLocale(locale, text) {
  const l = String(locale || "").trim().toLowerCase();
  if (l) return l.split("-")[0];
  if (isArabicText(text)) return "ar";
  return "en";
}

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function buildDataUrl(base64, mime = "image/jpeg") {
  // base64 may come with "data:*/*;base64,...." already
  const b = String(base64 || "");
  if (b.startsWith("data:")) return b;
  return `data:${mime};base64,${b}`;
}

async function callOpenAIResponses({ model, input, temperature = 0.2, max_output_tokens = 600 }) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
      temperature,
      max_output_tokens,
    }),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.error?.message || `OpenAI error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.body = json;
    throw err;
  }
  return json;
}

function extractOutputText(respJson) {
  // Responses API returns output items; gather output_text parts.
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

  // fallback (some SDKs expose resp.output_text)
  if (!text && typeof respJson?.output_text === "string") text = respJson.output_text;

  return (text || "").trim();
}

async function transcribeAudioToText({ base64Audio, filename = "audio.m4a", mimeType = "audio/m4a" }) {
  const clean = String(base64Audio || "").replace(/^data:.*;base64,/, "");
  const buf = Buffer.from(clean, "base64");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fixlens-"));
  const filePath = path.join(tmpDir, filename);
  fs.writeFileSync(filePath, buf);

  const ext = path.extname(filename).toLowerCase().replace(".", "");
  const allowed = new Set(["flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"]);
  if (ext && !allowed.has(ext)) {
    // cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const e = new Error(`UNSUPPORTED_AUDIO_FORMAT:${ext || "unknown"}`);
    e.status = 400;
    throw e;
  }

  // multipart/form-data (native fetch FormData in Node 18+)
  const fd = new FormData();
  fd.append("model", "gpt-4o-mini-transcribe"); // transcription model
  fd.append("file", new Blob([buf], { type: mimeType }), filename);

  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}` },
    body: fd,
  });

  const json = await r.json().catch(() => ({}));
  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  if (!r.ok) {
    const msg = json?.error?.message || `Transcription error ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.body = json;
    throw err;
  }

  return (json?.text || "").trim();
}

/**
 * Main handler used by server.js
 * Expected payload from Flutter:
 * {
 *   text: string,
 *   locale: string,
 *   image_base64?: string, image_mime?: string,
 *   image_url?: string,
 *   audio_base64?: string, audio_filename?: string, audio_mime?: string
 * }
 */
export async function handleFixLensRequest(payload = {}) {
  if (!OPENAI_KEY) {
    const e = new Error("Missing OPENAI_API_KEY");
    e.status = 500;
    throw e;
  }

  const userText = safeStr(payload.text);
  const locale = normalizeLocale(payload.locale, userText);

  // 1) Prepare multimodal user content
  const userContent = [];

  // Always include text first (so model gets context)
  if (userText) {
    userContent.push({ type: "input_text", text: userText });
  } else {
    userContent.push({
      type: "input_text",
      text: locale === "ar"
        ? "اكتب وصف المشكلة (سنة/موديل + الأعراض + متى تظهر)."
        : "Describe the problem (year/make/model + symptoms + when it happens).",
    });
  }

  // Image (either base64 or URL)
  if (payload.image_base64) {
    const mime = safeStr(payload.image_mime) || "image/jpeg";
    const dataUrl = buildDataUrl(payload.image_base64, mime);
    userContent.push({ type: "input_image", image_url: dataUrl, detail: "low" });
  } else if (payload.image_url) {
    userContent.push({ type: "input_image", image_url: safeStr(payload.image_url), detail: "low" });
  }

  // Audio → transcribe then add transcript as input_text
  if (payload.audio_base64) {
    try {
      const transcript = await transcribeAudioToText({
        base64Audio: payload.audio_base64,
        filename: safeStr(payload.audio_filename) || "audio.m4a",
        mimeType: safeStr(payload.audio_mime) || "audio/m4a",
      });

      if (transcript) {
        userContent.push({
          type: "input_text",
          text: locale === "ar"
            ? `تفريغ الصوت (Transcript):\n${transcript}`
            : `Audio transcript:\n${transcript}`,
        });
      }
    } catch (err) {
      // If unsupported format (like .caf), tell user clearly instead of crashing.
      const msg = String(err?.message || "");
      if (msg.startsWith("UNSUPPORTED_AUDIO_FORMAT")) {
        const ext = msg.split(":")[1] || "unknown";
        userContent.push({
          type: "input_text",
          text: locale === "ar"
            ? `ملاحظة تقنية: ملف الصوت بصيغة غير مدعومة (${ext}). سجّل الصوت بصيغة m4a أو wav ثم أعد الإرسال.`
            : `Tech note: audio format not supported (${ext}). Please record as m4a or wav and resend.`,
        });
      } else {
        userContent.push({
          type: "input_text",
          text: locale === "ar"
            ? `ملاحظة: تعذر تفريغ الصوت حالياً. أكمل التشخيص بالوصف النصي.`
            : `Note: audio transcription failed right now. We'll continue using text description.`,
        });
      }
    }
  }

  // 2) System rules (FixLens Doctor style) — keep EN only, but obey user's language
  const system = `
You are FixLens — a calm, professional second-opinion assistant for car problems.

Mission:
Reduce confusion and unnecessary spending. Be practical, not showy.

Language:
- ALWAYS reply in the user's language.
- If the user writes Arabic, reply in Arabic.
- Never switch languages (do not answer in Spanish unless the user wrote Spanish).

Rules:
1) Never give an absolute diagnosis. Use probability language (likely, common, often).
2) List at most 3 likely causes.
3) Always say whether it seems safe to keep driving right now.
4) Ask at most ONE follow-up question, only if it meaningfully changes next steps.
5) If image/audio is provided, incorporate it. Do NOT say you "can't analyze photos" unless no image was actually provided to you.

Style:
Short, human, confident, calm. No long essays.
`.trim();

  // 3) Call OpenAI Responses API with correct input shape (message + content)
  const input = [
    { role: "system", content: [{ type: "input_text", text: system }] },
    { role: "user", content: userContent },
  ];

  const resp = await callOpenAIResponses({
    model: FIXLENS_MODEL,
    input,
    temperature: 0.25,
    max_output_tokens: 700,
  });

  const answer = extractOutputText(resp);

  if (!answer) {
    const e = new Error("Empty model response");
    e.status = 502;
    e.body = resp;
    throw e;
  }

  return {
    ok: true,
    locale,
    model: FIXLENS_MODEL,
    reply: answer,
  };
}
