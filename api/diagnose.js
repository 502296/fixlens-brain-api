// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { buildSystemPrompt } from "../lib/prompt.js";

export const config = { runtime: "nodejs18.x" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, preferredLanguage } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const issues = findRelevantIssues(String(message));

    const system = buildSystemPrompt(preferredLanguage || "auto");

    const userText = `
User message:
${message}

Relevant issues from internal database (if any):
${JSON.stringify(issues, null, 2)}
`.trim();

    const out = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
      temperature: 0.4,
    });

    const reply = (out.output_text || "").trim();
    return res.status(200).json({ reply: reply || "No reply." });
  } catch (e) {
    return res.status(500).json({
      error: "Text diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
