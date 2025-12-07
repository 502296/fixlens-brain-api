// api/diagnose.js

import OpenAI from "openai";
import autoKnowledge from "../lib/autoKnowledge.js";
import commonIssues from "../data/auto_common_issues.json" assert { type: "json" };

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// helper: نضمن الرد بصيغة JSON حتى يكون ثابت
function buildSystemPrompt() {
return `
You are **FixLens Auto**, a super-intelligent automotive diagnostic assistant.

GOALS:
- Help drivers understand what might be happening with their vehicle.
- ALWAYS keep the driver safe.
- Use the knowledge provided (autoKnowledge + commonIssues) as context.

LANGUAGE:
- Detect the driver's language from their message.
- Reply in the SAME language as the driver (Arabic, English, Spanish, French, etc.).
- If the language is unclear or mixed, reply in simple English.

BEHAVIOR:
- If the message is just a greeting (e.g., "hello", "هلو", "hola", "hej", "سلام", etc.),
DO NOT generate a diagnosis.
Instead:
1) Greet the driver nicely in their language.
2) Ask them to describe the problem: noises, lights, leaks, smells, when it happens, etc.

- If the message does NOT contain any clear vehicle symptom (for example a random word,
an unclear phrase, or an unrelated text):
1) Explain that the description is unclear.
2) Ask the driver to describe the car issue in more detail.
3) Give 2–3 example questions they can answer (when, where, what sound, any warning lights).

- If there **is** a clear vehicle symptom, follow this structure EXACTLY:

1) Short title:
- One line summary of the main issue (in the same language).

2) Most likely causes:
- 2–4 bullet points.
- Use simple, clear language.
- If there is risk of catalytic converter damage or safety risk, mention it.

3) What to check now:
- 3–6 bullet points: practical checks, scan codes, what the mechanic should inspect.
- Prioritize simple checks first, then advanced ones.

4) Safety note:
- Short, practical safety advice.
- If the issue is severe (flashing check engine, brake problems, steering, overheating, etc.),
clearly say that the driver should avoid driving and get professional help quickly.

STYLE:
- Be friendly, calm, and professional.
- No extra introductions. Start directly with point 1), 2), 3), 4).
- Keep each answer compact and easy to read on a phone.
- You can reference general systems (ignition, fuel, cooling, suspension, brakes),
but avoid guessing exact part numbers or prices.

KNOWLEDGE:
- You have background context from "autoKnowledge" and "commonIssues" below.
- Use it for better reasoning, but do NOT mention these variable names in the answer.
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

const systemPrompt = buildSystemPrompt();

const knowledgeBlob = {
autoKnowledge,
commonIssues,
mode,
extraContext,
};

const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.3,
max_tokens: 900,
messages: [
{
role: "system",
content: systemPrompt,
},
{
role: "system",
content:
"BACKGROUND KNOWLEDGE (do NOT show this to the user):\n" +
JSON.stringify(knowledgeBlob).slice(0, 12000),
},
{
role: "user",
content: userMessage,
},
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
