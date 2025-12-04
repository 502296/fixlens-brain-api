// api/diagnose.js
// Vercel Serverless Function – FixLens Brain (TEXT)

const fs = require("fs");
const path = require("path");

// نحاول تحميل ملفات معرفة الأعطال للسيارات (اختياري لكن مفيد)
function loadKnowledge() {
try {
const baseDir = path.join(process.cwd(), "brain", "knowledge");
const carPath = path.join(baseDir, "car.json");
const carExtraPath = path.join(baseDir, "car_extra.json");

let chunks = [];

if (fs.existsSync(carPath)) {
const carText = fs.readFileSync(carPath, "utf8");
chunks.push(carText);
}

if (fs.existsSync(carExtraPath)) {
const extraText = fs.readFileSync(carExtraPath, "utf8");
chunks.push(extraText);
}

if (chunks.length === 0) return "";

return chunks.join("\n\n");
} catch (err) {
console.error("Error loading knowledge files:", err);
return "";
}
}

const KNOWLEDGE = loadKnowledge();

module.exports = async (req, res) => {
// فقط POST مسموح
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const body = req.body || {};
const message = body.message;
const mode = body.mode || "text"; // حالياً نركز على text

if (!message || typeof message !== "string" || !message.trim()) {
return res
.status(400)
.json({ error: "Field 'message' is required as non-empty string." });
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
console.error("Missing OPENAI_API_KEY");
return res.status(500).json({
error: "Server misconfigured: OPENAI_API_KEY is missing.",
});
}

// System prompt مخصص لـ FixLens Auto
const systemPrompt = `
You are **FixLens Auto**, a friendly, highly skilled AI car diagnostician.

- You specialize in real-world car problems: engine, transmission, vibrations, noises, warning lights, electrical issues, body & paint.
- You ALWAYS answer in the same language the user uses (Arabic, English, Spanish, etc.).
- For every answer:
1) Start with a short friendly greeting.
2) Brief summary of what you understood.
3) List the most likely causes.
4) Give step-by-step checks the driver can do safely.
5) Add clear safety warnings if there is any risk (e.g. “Do not drive the car”).
- If the user message is just "hello" or a greeting, respond like a professional mechanic assistant and ask what car issue they have.

You have access to a small knowledge base of car issues in JSON form (if present). Use it only as **extra context**, but you can go beyond it.

KNOWLEDGE JSON (if any):

${KNOWLEDGE}
`.trim();

const openaiResponse = await fetch(
"https://api.openai.com/v1/chat/completions",
{
method: "POST",
headers: {
Authorization: `Bearer ${apiKey}`,
"Content-Type": "application/json",
},
body: JSON.stringify({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: message },
],
temperature: 0.6,
}),
}
);

const data = await openaiResponse.json();

if (!openaiResponse.ok) {
console.error("OpenAI error:", data);
return res.status(500).json({
error: "OpenAI API error",
details: data,
});
}

const reply =
data.choices?.[0]?.message?.content?.trim() ||
"Sorry, FixLens Auto could not generate a response.";

// هذا الشكل الذي ينتظره تطبيق Flutter
return res.status(200).json({ reply });
} catch (err) {
console.error("Unexpected error in /api/diagnose:", err);
return res.status(500).json({ error: "Internal server error" });
}
};
