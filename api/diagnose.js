// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
runtime: "nodejs18.x"
};

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
try {
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

const { message, preferredLanguage } = req.body;

if (!message || !message.trim()) {
return res.status(400).json({ error: "Message is required" });
}

// AutoKnowledge
const issues = findRelevantIssues(message);

const prompt = `
You are FixLens Auto, the world’s smartest vehicle diagnostic AI.
User language: ${preferredLanguage || "auto-detect"}.
User message: ${message}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in user's language.
Provide:
1. Quick Summary
2. Most likely causes
3. Recommended next steps
4. Safety warnings
`;

const ai = await client.chat.completions.create({
model: "gpt-4.1",
messages: [{ role: "user", content: prompt }]
});

return res.status(200).json({
reply: ai.choices[0].message.content
});

} catch (err) {
console.error("TEXT ERROR:", err);
return res.status(500).json({ error: "FixLens text failed", details: err.message });
}
}
