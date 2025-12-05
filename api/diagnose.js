// api/diagnose.js
// Text & Image diagnosis for FixLens Brain (Vercel Serverless Function)

export default async function handler(req, res) {
// نسمح فقط بطلبات POST
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

// قراءة الـ body كـ JSON سواء جاء object أو string
let body = req.body;
if (!body || typeof body === "string") {
try {
body = JSON.parse(body || "{}");
} catch (e) {
return res.status(400).json({ error: "Invalid JSON body" });
}
}

const { text, image } = body || {};

// لازم يكون موجود واحد على الأقل: text أو image
if (!text && !image) {
return res
.status(400)
.json({ error: "Either 'text' or 'image' field is required." });
}

// نجهّز نص المستخدم الذي سنرسله لـ OpenAI
const userPrompt = text
? text
: `The user sent this image (base64-encoded). Describe the most likely problem and suggestions to fix it.\n\nIMAGE_BASE64:\n${image?.substring(
0,
8000,
)}`;

try {
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
return res
.status(500)
.json({ error: "Missing OPENAI_API_KEY in environment variables." });
}

// استدعاء OpenAI Chat Completions
const openaiResponse = await fetch(
"https://api.openai.com/v1/chat/completions",
{
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: `Bearer ${apiKey}`,
},
body: JSON.stringify({
model: "gpt-4o-mini",
messages: [
{
role: "system",
content:
"You are FixLens, an expert diagnostic assistant for cars and home problems. " +
"Ask for safety first, then give clear, practical steps, short and helpful.",
},
{
role: "user",
content: userPrompt,
},
],
temperature: 0.4,
max_tokens: 500,
}),
},
);

if (!openaiResponse.ok) {
const errText = await openaiResponse.text();
console.error(
"OpenAI error:",
openaiResponse.status,
errText.slice(0, 500),
);
return res.status(500).json({
error: "OpenAI error",
status: openaiResponse.status,
details: errText,
});
}

const data = await openaiResponse.json();
const reply =
data.choices?.[0]?.message?.content ||
"FixLens could not generate an answer.";

// ✅ هذا الشكل اللي Flutter ينتظره
return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "Internal FixLens error",
details: err.message || String(err),
});
}
}
