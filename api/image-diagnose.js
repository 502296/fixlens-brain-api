// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

    const { image, text = "", preferredLanguage } = req.body || {};

    if (!image) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    const lang = preferredLanguage || guessLanguage(text) || "en";
    const issues = text ? findRelevantIssues(text) : [];

    const promptText = `
User note:
${text || "(no text)"}

Respond in (${lang}) naturally.
Use this structure:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip

If user note is empty, infer from image only.
Relevant issues (optional):
${JSON.stringify(issues, null, 2)}
`.trim();

    const ai = await client.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: promptText },
            {
              type: "input_file",
              mime_type: "image/jpeg",
              data: image,
            },
          ],
        },
      ],
    });

    return res.status(200).json({
      reply: ai.output_text || "",
      language: lang,
    });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
