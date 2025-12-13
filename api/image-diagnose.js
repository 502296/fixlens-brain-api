// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const client = new OpenAI({
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

    // expecting JSON: { image: "<base64>", text?: "optional notes", preferredLanguage?: "ar|en|..." }
    const { image, text = "", preferredLanguage } = req.body ?? {};

    if (!image || !String(image).trim()) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    const lang = preferredLanguage || guessLanguage(text) || "en";
    const issues = text ? findRelevantIssues(text) : [];

    const userText = `
User note (may be empty):
${text || "(none)"}

Relevant automotive issues from internal database (if any):
${JSON.stringify(issues, null, 2)}

Respond naturally in ${lang}.
Follow the response structure exactly.
Assume the user is a mechanic.
`.trim();

    const ai = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${image}` },
            },
          ],
        },
      ],
    });

    const reply = ai.choices?.[0]?.message?.content?.trim() || "";
    return res.status(200).json({ reply, language: lang });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
