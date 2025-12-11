// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs20.x"
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage = "auto" } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Load relevant car issues
    const issues = findRelevantIssues(message);

    const systemPrompt = `
You are FixLens Auto, the world’s smartest AI for vehicle diagnostics.
Your job:
- Detect the user’s language automatically.
- Explain clearly what is happening.
- Use the internal autoKnowledge JSON to improve accuracy.
- Respond in the user’s own language.
- Be structured, clear, and professional.

Your response must include:
1. Quick Summary
2. Most Likely Causes
3. Recommended Next Steps
4. Safety Warnings
`;

    const userPrompt = `
User message:
"${message}"

Relevant issues from internal database:
${JSON.stringify(issues, null, 2)}
`;

    const ai = await client.responses.create({
      model: "gpt-5.1",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userPrompt }]
        }
      ]
    });

    return res.status(200).json({
      reply: ai.output_text
    });

  } catch (err) {
    console.error("TEXT ERROR:", err);
    return res.status(500).json({
      error: "FixLens text failed",
      details: err.message
    });
  }
}
