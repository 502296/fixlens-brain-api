// api/audio-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Detect preferred language
function detectLanguageHint(lang) {
  if (!lang || lang === "auto") {
    return "Reply using the same language detected from the transcription if possible.";
  }
  if (lang === "ar") return "أجب باللغة العربية.";
  if (lang === "en") return "Reply in clear English.";
  return "Reply in the user's language if possible.";
}

export default async function handler(req, res) {
  try {
    const {
      audioBase64,
      mimeType = "audio/m4a",
      language = "auto",
      note,
    } = req.body || {};

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audioBase64" });
    }

    // 1) TRANSCRIBE AUDIO (gpt-4o-mini-transcribe)
    const transcribe = await openai.audio.transcriptions.create({
      file: {
        data: Buffer.from(audioBase64, "base64"),
        name: "audio.m4a",
      },
      model: "gpt-4o-mini-transcribe",
    });

    const text = transcribe.text || "";

    console.log("TRANSCRIBED TEXT:", text);

    // 2) ANALYZE TEXT AS CAR PROBLEM
    const langHint = detectLanguageHint(language);

    const prompt =
      `${langHint}\n\n` +
      `The user submitted an audio recording. Here is the extracted description:\n\n` +
      `"${text}"\n\n` +
      (note ? `Extra note: ${note}\n\n` : "") +
      `Your task is to analyze this as a possible vehicle/mechanical issue.\n\n` +
      `Format your answer exactly like this:\n` +
      `**Quick Summary:**\n` +
      `**Most Likely Causes:** (numbered list)\n` +
      `**What You Can Check Now:**\n` +
      `**Safety / When to Stop Driving:**\n` +
      `**Next Professional Step:**`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FixLens Auto, a car diagnostics AI." },
        { role: "user", content: prompt },
      ],
    });

    let reply = completion.choices[0]?.message?.content ?? "";

    // 3) Integrate with FixLens Knowledge Base
    try {
      const extra = await findRelevantIssues(text, language);
      if (extra) {
        reply += `\n\n---\n\n${
          language === "ar"
            ? "معلومات إضافية من قاعدة FixLens:\n"
            : "Additional insights from FixLens knowledge base:\n"
        }${extra}`;
      }
    } catch {}

    return res.status(200).json({
      reply,
      language,
      transcribed: text,
    });
  } catch (err) {
    console.error("Audio Diagnose Error:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message,
    });
  }
}
