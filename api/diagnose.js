// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  if (/[áéíóúñ¿¡]/i.test(t)) return "es";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const issues = findRelevantIssues(String(message));
    const detected = guessLanguage(String(message));
    const lang = preferredLanguage || detected || "auto";

    const prompt = `
You are FixLens Auto, the world’s smartest vehicle diagnostic AI.

User language: ${lang}
User message: ${message}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in the user's language (or auto-detect).
Format exactly:
1) Quick Summary
2) Most likely causes (ranked)
3) Recommended next steps (simple + practical)
4) Safety warnings (only if needed)
`;

    // ✅ Responses API (الأحدث)
    const response = await client.responses.create({
      model: "gpt-5.2",
      input: prompt,
    });

    return res.status(200).json({
      reply: response.output_text || "",
      language: lang,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
