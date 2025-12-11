// api/audio-diagnose.js
// FixLens Sound Lab – JSON base64 audio (no multipart)

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// تخمين لغة مبسّط من النص
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Russian
  if (/[áéíóúñüÁÉÍÓÚÑÜ]/.test(t)) return "es"; // Spanish-ish
  if (/[äöüßÄÖÜ]/.test(t)) return "de"; // German-ish
  if (/[àâçéèêëîïôûùüÿÀÂÇÉÈÊËÎÏÔÛÙÜŸ]/.test(t)) return "fr"; // French-ish

  return "en";
}

// نحدد صيغة الصوت من mimeType القادم من Flutter
function detectFormatFromMime(mimeType) {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("m4a")) return "m4a"; // Flutter record غالبًا
  return "m4a";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    let body = req.body;

    // احتياط لو جاء كنص
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    const {
      audioBase64,
      mimeType,
      language: preferredLanguage = "auto",
    } = body || {};

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({
        error: "audioBase64 is required in request body",
      });
    }

    const format = detectFormatFromMime(mimeType);
    const userLang =
      preferredLanguage && preferredLanguage !== "auto"
        ? preferredLanguage
        : null;

    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_AUDIO_MODEL || "gpt-audio",
      modalities: ["text", "audio"],
      audio: {
        voice: "alloy",
        format: "wav", // نطنش الـ output audio حالياً
      },
      messages: [
        {
          role: "system",
          content: `
You are **FixLens Auto – Sound Lab v3**, a world-class AI mechanic
specialized in diagnosing car problems *purely from sound*.

You receive a recording from somewhere in or around a vehicle:
engine bay, exhaust, suspension, brakes, steering, or cabin.

Analyze the waveform itself (knocking, pinging, tapping, squeaking,
grinding, whining, humming, rattling, hissing, rumbling, etc.)
and map it to likely mechanical causes.

For each likely cause:
- Explain why the sound pattern matches.
- Give an approximate probability (sum ~ 1.0).
- Give a risk level: CRITICAL / HIGH / MEDIUM / LOW.
- Give clear next steps for the driver.

LANGUAGE:
- If "preferredLanguage" is given, answer in that language code (ar, en, es, ...).
- If preferredLanguage = "auto", try to match the driver's spoken language if any.
- Be calm, friendly, and honest about uncertainty.
          `.trim(),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                userLang != null
                  ? `This is a car sound recording. Analyze ONLY the mechanical sound and answer in language code: ${userLang}.`
                  : `This is a car sound recording from a vehicle. Analyze ONLY the mechanical sound (not my words) and reply in the same language as the driver if possible.`,
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format,
              },
            },
          ],
        },
      ],
    });

    const choice = completion.choices[0];
    let replyText = "";

    if (typeof choice.message.content === "string") {
      replyText = choice.message.content;
    } else if (Array.isArray(choice.message.content)) {
      const textPart = choice.message.content.find((p) => p.type === "text");
      replyText = textPart?.text || JSON.stringify(choice.message.content);
    } else {
      replyText = JSON.stringify(choice.message);
    }

    const detectedLang = guessLanguage(replyText);
    const finalLang =
      userLang != null && userLang !== "auto" ? userLang : detectedLang || "en";

    return res.status(200).json({
      reply: replyText,
      language: finalLang,
    });
  } catch (e) {
    console.error("FixLens Sound Lab error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message || String(e),
    });
  }
}
