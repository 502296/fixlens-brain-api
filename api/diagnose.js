// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);
    const message = (body.message || body.text || "").toString();
    const preferredLanguage = (body.language || "auto").toString();

    if (!message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const issues = findRelevantIssues(message);

    const prompt = `
You are FixLens Auto, an expert vehicle diagnostic AI.
User language: ${preferredLanguage} (if "auto", reply in the user's language).
User message: ${message}

Relevant automotive issues from internal database (may be empty):
${JSON.stringify(issues, null, 2)}

Return:
1) Quick Summary
2) Most likely causes (ranked)
3) Recommended next steps
4) Safety warnings (if any)
Be concise but helpful.
`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt },
      ],
    });

    const reply = resp?.choices?.[0]?.message?.content || "No reply.";

    return res.status(200).json({
      reply,
      language: preferredLanguage,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Text diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
