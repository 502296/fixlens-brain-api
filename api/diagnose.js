// api/diagnose.js
// Main FixLens Auto diagnosis endpoint (text + optional image)
// يدعم: نص فقط، صورة فقط، أو نص + صورة
// ويرجع دائماً: { answer: "..." }

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
const { text, image, language } = req.body || {};

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
kbMatches = [];
}

const systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostician.

You receive:
- The driver's description of the issue (noises, warning lights, behavior, conditions).
- Optionally an attached photo from the app.
- A small JSON "knowledge base" of common automotive issues.

Language rules:
- Detect the language of the driver's description.
- If a language code is provided from the app, you may use it as a hint (e.g. "ar", "en").
- ALWAYS answer in the **same language** the driver used.
- Keep the tone clear, friendly, and professional.

Diagnostic rules:
1. Use the JSON knowledge base as a starting point if any items match the symptoms.
2. Combine that with your broader professional experience.
3. Always:
- Start with a short, clear title line.
- Then "Most likely causes" as a bullet list.
- Then "What to check now" as a bullet list.
- If there is any safety risk, include a final line: "Safety note:".
4. Do NOT mention JSON, the word "knowledge base", or that you are an AI model.
`;

const kbText =
kbMatches.length > 0
? JSON.stringify(kbMatches, null, 2)
: "No strong matches from the built-in knowledge base.";

const userPrompt = `
Driver description:
${description || "(no text, image-only case)"}

Image attached by user: ${
image ? "YES (base64 data URL sent from mobile app)" : "NO"
}

App language hint (optional): ${language || "(none)"}

Top internal knowledge base matches (for you to consider):
${kbText}

Now, give the best diagnostic explanation you can, following the required format and replying in the SAME language as the driver's description.
`;

// 👁️‍🗨️ لو توجد صورة، نرسلها مع النص كـ image_url (يدعمها gpt-4.1-mini)
const hasImage = typeof image === "string" && image.trim().length > 0;

const messages = hasImage
? [
{ role: "system", content: systemPrompt },
{
role: "user",
content: [
{ type: "text", text: userPrompt },
{
type: "image_url",
image_url: {
url: image, // data:image/jpeg;base64,...
},
},
],
},
]
: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
];

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
messages,
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

// ✅ دائماً نرجّع answer (وليس reply فقط)
return res.status(200).json({ answer: reply });
} catch (err) {
console.error("diagnose handler error:", err);
return res
.status(500)
.json({ error: "Server error", details: String(err) });
}
}
