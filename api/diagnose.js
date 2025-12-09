import OpenAI from "openai";
import { loadIssues, findMatchingIssue } from "../lib/autoKnowledge.js";

export const config = {
runtime: "edge",
};

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req) {
try {
const body = await req.json();
const userMessage = body.message || "";
if (!userMessage.trim()) {
return new Response(JSON.stringify({ error: "Empty message" }), { status: 400 });
}

// Load local auto knowledge
const issues = loadIssues();
const matched = findMatchingIssue(userMessage, issues);

let systemPrompt = `
You are FixLens Auto — an AI automotive expert.
You ALWAYS detect the user's language first and respond in the same language.
If user speaks Arabic → respond in Arabic.
If Spanish → respond in Spanish.
If English → respond fully in English.

Your goals:
1) Understand symptoms (noise, vibration, leaks, smells, misfires…)
2) Give clear diagnosis possibilities.
3) Provide steps to verify.
4) Provide severity + urgency.

If you find a match in internal automotive knowledge, blend it with your reasoning.

Return ONLY the AI message. Do not add disclaimers unless needed.
`;

let autoKnowledgeBlock = "";
if (matched) {
autoKnowledgeBlock = `
Internal Issue Match:
Short Symptom: ${matched.symptom_short}
Likely Causes:
${matched.likely_causes.map(c => `- ${c.cause} (prob: ${c.probability}, severity: ${c.severity}, urgency: ${c.urgency})`).join("\n")}
Notes: ${matched.notes}
`;
}

const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: systemPrompt },
{ role: "system", content: autoKnowledgeBlock },
{ role: "user", content: userMessage }
]
});

const reply = completion.choices[0].message.content;

return new Response(JSON.stringify({
reply,
language: completion.choices[0].message?.language || null
}), { status: 200 });

} catch (err) {
return new Response(JSON.stringify({
error: "SERVER_ERROR",
details: err.message
}), { status: 500 });
}
}
