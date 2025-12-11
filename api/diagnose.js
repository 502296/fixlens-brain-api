// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs20.x",
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { message, language = "auto" } = req.body ?? {};
    if (!message) return res.status(400).json({ error: "No message provided" });

    const issues = findRelevantIssues(message);

    const promptText = `
User message:
${message}

Relevant mechanical knowledge:
${JSON.stringify(issues, null, 2)}

Language requested: ${language}

Act as FixLens Auto — the most advanced automotive diagnostic AI.
Explain clearly, detect symptoms, provide causes and next steps.
`;

    const result = await client.chat.completions.create({
      model: "gpt-5.1",
      messages: [{ role: "user", content: promptText }],
    });

    const reply = result.choices[0].message.content;

    return res.status(200).json({
      reply,
      language,
    });
  } catch (err) {
    return res.status(500).json({
      error: "A server error has occurred",
      details: err.message,
    });
  }
}
