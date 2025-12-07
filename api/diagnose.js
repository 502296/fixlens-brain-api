// api/diagnose.js

import OpenAI from "openai";
import autoKnowledge from "../lib/autoKnowledge.js";
import fs from "fs";
import path from "path";

const commonIssuesPath = path.join(process.cwd(), "data/auto_common_issues.json");
const commonIssues = JSON.parse(fs.readFileSync(commonIssuesPath, "utf8"));

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

function buildSystemPrompt() {
return `
You are **FixLens Auto**, a super-intelligent automotive diagnostic assistant.

GOALS:
- Help drivers understand what might be happening with their vehicle.
- ALWAYS keep the driver safe.
- Use the knowledge provided (autoKnowledge + commonIssues) as context.

LANGUAGE:
- Detect the driver's language from their message.
- Reply in the SAME language as the driver.
- If unclear, reply in simple English.

BEHAVIOR:
- Greeting only → greet + ask for symptoms.
- No clear car issue → ask for more details + give examples.

If clear symptoms exist → follow EXACT format:
1) Short title
2) Most likely causes (bullets)
3) What to check now
4) Safety note

STYLE: friendly, concise.
`;
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { message, mode = "text", extraContext = {} } = req.body || {};
if (!message || typeof message !== "string" || !message.trim()) {
return res.status(400).json({ error: "Message is required" });
}

const userMessage = message.trim();

const knowledgeBlob = {
autoKnowledge,
commonIssues,
mode,
extraContext,
};

const systemPrompt = buildSystemPrompt();

const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.3,
max_tokens: 900,
messages: [
{ role: "system", content: systemPrompt },
{
role: "system",
content:
"BACKGROUND KNOWLEDGE:\n" +
JSON.stringify(knowledgeBlob).slice(0, 12000),
},
{ role: "user", content: userMessage },
],
});

const reply =
completion.choices?.[0]?.message?.content ||
"Sorry, something went wrong while generating the diagnosis.";

return res.status(200).json({
ok: true,
source: "diagnose",
mode,
message: userMessage,
answer: reply,
});
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
ok: false,
error: "Internal error while generating diagnosis.",
});
}
}
