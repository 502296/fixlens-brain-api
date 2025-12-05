// api/diagnose.js
// Text & Image diagnosis for FixLens Brain (Vercel Serverless Function)

export default async function handler(req, res) {
// Only allow POST
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

// Parse JSON body safely
let body = req.body;
if (!body || typeof body === "string") {
try {
body = JSON.parse(body || "{}");
} catch (e) {
return res.status(400).json({ error: "Invalid JSON body" });
}
}

const { text, image } = body || {};

// Need at least text OR image
if (!text && !image) {
return res
.status(400)
.json({ error: "Either 'text' or 'image' field is required." });
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
return res
.status(500)
.json({ error: "Missing OPENAI_API_KEY in environment variables." });
}

try {
let messages;

if (image) {
// ---------- IMAGE DIAGNOSIS (VISION) ----------
// image هنا هو base64 قادم من Flutter
const imageUrl = image.startsWith("data:")
? image
: `data:image/jpeg;base64,${image}`;

messages = [
{
role: "system",
content: [
{
type: "text",
text:
"You are FixLens, an expert diagnostic assistant for cars and home problems. " +
"You can see and analyze images. Always mention safety first, then give clear, practical steps.",
},
],
},
{
role: "user",
content: [
{
type: "text",
text:
"Look carefully at this image and describe the most likely problem, " +
"what part of the car or object is affected, and step-by-step actions to diagnose and fix it. " +
"If something looks dangerous, warn the user clearly.",
},
{
type: "image_url",
image_url: {
url: imageUrl,
},
},
],
},
];
} else {
// ---------- TEXT DIAGNOSIS ----------
messages = [
{
role: "system",
content:
"You are FixLens, an expert diagnostic assistant for cars and home problems. " +
"Ask for safety first, then give clear, practical steps, short and helpful.",
},
{
role: "user",
content: text,
},
];
}

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
messages,
temperature: 0.4,
max_tokens: 600,
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

// الشكل الذي ينتظره تطبيق Flutter
return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "Internal FixLens error",
details: err.message || String(err),
});
}
}
