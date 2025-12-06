// api/diagnose.js
// Main FixLens Auto diagnosis endpoint (text + optional image)

import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

if (!OPENAI_API_KEY) {
return res
.status(500)
.json({ error: "Missing OPENAI_API_KEY in environment." });
}

try {
const { text, image } = req.body || {};

if (!text && !image) {
return res.status(400).json({
error: "Please provide at least 'text' or 'image' in the request body.",
});
}

const description = text || "";

// 1) نبحث في قاعدة الأعطال عن أكثر الأشياء التي تشبه وصف المستخدم
let kbMatches = [];
try {
kbMatches = findMatchingIssues(description, 5);
} catch (err) {
console.error("Error loading knowledge base:", err);
// ما نكسر الطلب، بس نكمل بدون KB
kbMatches = [];
}

const systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostician.

You receive:
- The driver's description of the issue (noises, warning lights, behavior, conditions).
- Optionally an attached photo from the app (image is referenced but not directly visible to you).
- A small JSON "knowledge base" of common automotive issues.

Language rules:
1. First, detect the main language of the driver's description (for example: English, Arabic, Spanish, French, etc.).
2. Always reply in the **same main language** as the driver's description.
3. If the description is strongly mixed between languages, reply in the language that seems most dominant or natural.
4. If you are not sure, default to **English**.

Diagnostic rules:
1. Use the JSON knowledge base as a starting point if any items match the symptoms.
2. Combine that with your broader professional experience.
3. Always:
- Start with a short, clear title line (e.g. "Possible misfire and ignition issue").
- Then "Most likely causes" as a clear bullet list.
- Then "What to check now" as a bullet list the driver or mechanic can actually do.
- If there is any safety risk, include a final line: "Safety note:" (translated to the reply language).
4. Do NOT mention JSON, the word "knowledge base", or that you are an AI model.
`;

const kbText =
kbMatches.length > 0
? JSON.stringify(kbMatches, null, 2)
: "No strong matches from the built-in knowledge base.";

const userPrompt = `
Driver description:
${description || "(no text, image-only case)"}

Image attached by user: ${image ? "YES (base64 sent from mobile app)" : "NO"}

Top internal knowledge base matches (for you to consider):
${kbText}

Now, give the best diagnostic explanation you can, following the required format and language rules.
`;

const openaiRes = await fetch(
"https://api.openai.com/v1/chat/completions",
{
method: "POST",
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
"Content-Type": "application/json",
},
body: JSON.stringify({
model: FIXLENS_MODEL,
temperature: 0.4,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
],
}),
}
);

if (!openaiRes.ok) {
const errText = await openaiRes.text();
console.error("OpenAI error:", errText);
return res
.status(500)
.json({ error: "FixLens Brain error", details: errText });
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a diagnosis at the moment.";

return res.status(200).json({ reply });
} catch (err) {
console.error("diagnose handler error:", err);
return res
.status(500)
.json({ error: "Server error", details: String(err) });
}
}
