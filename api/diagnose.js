// api/diagnose.js
// FixLens Brain – Vehicle-only Text & Image Diagnosis (Vercel Serverless Function)

export default async function handler(req, res) {
// Allow POST only
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

// Require at least text OR image
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

// -------------- IMAGE DIAGNOSIS (VISION) --------------
if (image) {
// image is base64 coming from Flutter
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
"You are FixLens, an expert diagnostic assistant specialized ONLY in vehicles " +
"(cars, SUVs, pickup trucks). " +
"You can see and analyze images of car parts, underbody, engine bay, wheels, tires, " +
"brakes, suspensions, and fluid leaks. " +
"If the image does NOT appear to be related to a vehicle, politely say that FixLens " +
"is specialized in car diagnostics only and ask the user to send a car-related photo " +
"or describe their vehicle problem instead. " +
"Always start with a short safety note, then provide clear, step-by-step guidance " +
"to inspect, diagnose, and (when reasonable) fix the issue. Keep the answer practical.",
},
],
},
{
role: "user",
content: [
{
type: "text",
text:
"Look carefully at this image from a vehicle. Identify the most likely car-related " +
"problem, the affected component (for example: control arm, CV joint, power steering line, " +
"brake hose, tire, wheel, suspension, exhaust, etc.), and provide practical steps to inspect " +
"and address the issue. If anything looks unsafe (leaks, structural damage, severe rust, " +
"brake issues), clearly warn the user and recommend seeing a professional mechanic.",
},
{
type: "image_url",
image_url: { url: imageUrl },
},
],
},
];
} else {
// -------------- TEXT DIAGNOSIS --------------
messages = [
{
role: "system",
content:
"You are FixLens, an expert diagnostic assistant specialized ONLY in vehicles " +
"(cars, SUVs, pickup trucks). " +
"You answer questions about car noises, vibrations, leaks, warning lights, starting issues, " +
"steering, suspension, brakes, tires, overheating, and similar vehicle problems. " +
"If the question is NOT related to a vehicle, politely explain that FixLens is only for car " +
"diagnostics and ask the user to provide a vehicle-related question instead. " +
"Always begin with a brief safety reminder (engine off, parking brake, protective gear), then " +
"give clear, step-by-step instructions. Keep the tone friendly, practical, and concise.",
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

// Shape expected by Flutter
return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "Internal FixLens error",
details: err.message || String(err),
});
}
}
