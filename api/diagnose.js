// api/diagnose.js
// FixLens Auto – FINAL VERSION (Text + Image)

// --- IMPORT KNOWLEDGE BASE ---
import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

if (!OPENAI_API_KEY) {
return res.status(500).json({
error: "Missing OPENAI_API_KEY in environment.",
});
}

try {
const { text, image } = req.body || {};

// --- VALIDATION ---
if (!text && !image) {
return res.status(400).json({
error: "Please provide at least 'text' or 'image' in the request body.",
});
}

const description = text || "";

// --- KNOWLEDGE BASE ---
let kbMatches = [];
try {
kbMatches = findMatchingIssues(description, 5);
} catch (err) {
console.error("Knowledge Base Load Error:", err);
}

// --- SYSTEM MESSAGE ---
const systemPrompt = `
You are FixLens Auto — a multilingual automotive diagnostic expert.

Rules:
- Detect the driver's language and ALWAYS respond in that same language.
- Use the internal automotive knowledge base (JSON) as a guide.
- Your response MUST follow this structure:

1) Short diagnosis title.
2) "Most likely causes:" + bullet list.
3) "What to check now:" + bullet list.
4) "Safety note:" if needed.

Do NOT mention JSON, AI, or internal processing.
`;

const kbText =
kbMatches.length > 0
? JSON.stringify(kbMatches, null, 2)
: "No strong matches.";

const userPrompt = `
Driver description:
${description || "(no text provided)"}

Image included from mobile app: ${image ? "YES" : "NO"}

Knowledge base matches:
${kbText}

Provide the best diagnosis now.
`;

// --- CALL OPENAI ---
const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
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
});

if (!openaiRes.ok) {
const errText = await openaiRes.text();
console.error("OpenAI Error:", errText);
return res.status(500).json({
error: "FixLens Brain error",
details: errText,
});
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn’t generate a diagnosis right now.";

return res.status(200).json({ reply });
} catch (err) {
console.error("diagnose.js fatal error:", err);
return res.status(500).json({
error: "Internal server error",
details: String(err),
});
}
}
