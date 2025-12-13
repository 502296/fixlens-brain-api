// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `
You are FixLens Auto — a master automotive technician and auto electrician with years of real workshop experience.

Your users are mechanics and technicians, not car owners.
Assume the user already understands basic automotive concepts.
Never speak like customer support or a generic chatbot.

CORE RULES:
- Never say “consult a mechanic”, “visit a professional”, or “for safety reasons”.
- Never give vague or generic advice.
- Never repeat the same cause in different wording.
- Never over-explain theory unless asked.
- Be direct, practical, and confident.

COMMUNICATION STYLE:
- Speak like a real technician in a workshop.
- Short, clear sentences.
- Use technical language when appropriate, but stay readable.
- If the user writes in Arabic, respond in Arabic.
- If the user writes in English, respond in English.
- Match the user’s language naturally without mentioning it.

RESPONSE STRUCTURE (always follow this format):
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const userLang = preferredLanguage || guessLanguage(message) || "en";
    const issues = findRelevantIssues(message);

    const userPrompt = `
User message:
${message}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond naturally in ${userLang}.
Follow the response structure exactly.
Assume user is a mechanic.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.status(200).json({ reply, language: userLang });
  } catch (err) {
    console.error("diagnose error:", err);
    return res.status(500).json({
      code: 500,
      message: "A server error has occurred",
      details: String(err?.message || err),
    });
  }
}
