// api/diagnose.js
// FixLens Brain – Vehicle-only, multi-language, text + image diagnosis

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

let body = req.body;
if (!body || typeof body === "string") {
try {
body = JSON.parse(body || "{}");
} catch (e) {
return res.status(400).json({ error: "Invalid JSON body" });
}
}

const { text, image } = body || {};

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

// ---------- IMAGE (with optional text) ----------
if (image) {
const imageUrl = image.startsWith("data:")
? image
: `data:image/jpeg;base64,${image}`;

const userText =
(text && String(text).trim().length > 0)
? String(text).trim()
: "This is a photo from a vehicle. Identify the most likely car-related problem and explain what the user should check.";

messages = [
{
role: "system",
content: [
{
type: "text",
text:
"You are FixLens, an expert diagnostic assistant specialized ONLY in vehicles " +
"(cars, SUVs, pickup trucks). " +
"You must ALWAYS answer in the SAME LANGUAGE as the user's last message. " +
"If the user writes in Arabic, respond in Arabic. If in Spanish, respond in Spanish, etc. " +
"You help with car noises, vibrations, leaks, underbody photos, engine bay photos, wheels, tires, " +
"suspension, steering, and braking issues. " +
"If the image or question is not vehicle-related, politely say that FixLens is only for car diagnostics " +
"and ask the user to send a car-related description or photo. " +
"Always start with a short safety reminder, then give clear, step-by-step guidance.",
},
],
},
{
role: "user",
content: [
{
type: "text",
text: userText,
},
{
type: "image_url",
image_url: { url: imageUrl },
},
],
},
];
} else {
// ---------- TEXT ONLY ----------
const userText = String(text).trim();

messages = [
{
role: "system",
content:
"You are FixLens, an expert diagnostic assistant specialized ONLY in vehicles " +
"(cars, SUVs, pickup trucks). " +
"You must ALWAYS answer in the SAME LANGUAGE as the user's last message (unless they explicitly ask for a different language). " +
"You help with car noises, vibrations, leaks, warning lights, starting issues, steering, suspension, brakes, " +
"tires, overheating and similar vehicle problems. " +
"If the question is not about a vehicle, explain that FixLens is only for car diagnostics and ask for a vehicle-related question. " +
"Always begin with a short safety reminder (engine off, parking brake, protective gear), then provide practical, step-by-step instructions.",
},
{
role: "user",
content: userText,
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
max_tokens: 700,
}),
}
);

if (!openaiResponse.ok) {
const errText = await openaiResponse.text();
console.error(
"OpenAI error:",
openaiResponse.status,
errText.slice(0, 500)
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

return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "Internal FixLens error",
details: err.message || String(err),
});
}
}
