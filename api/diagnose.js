// api/diagnose.js
// FixLens Brain – Stable Multilingual Diagnosis (TEXT + IMAGE + AUDIO)

import OpenAI from "openai";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// 🔎 دالة صغيرة لاستخراج النص من رسالة المستخدم لأي مود
function getUserTextFromBody(body) {
if (!body) return "";
if (typeof body.message === "string" && body.message.trim().length > 0) {
return body.message.trim();
}
if (typeof body.audioTranscription === "string" && body.audioTranscription.trim().length > 0) {
return body.audioTranscription.trim();
}
if (typeof body.imageDescription === "string" && body.imageDescription.trim().length > 0) {
return body.imageDescription.trim();
}
return "";
}

// 🧠 برومبت عام – يشتغل لكل اللغات ولكل المودات
function buildSystemPrompt() {
return `
You are **FixLens Auto**, a smart assistant for vehicle diagnostics.

CRITICAL RULES:
- Always answer **in the same language** as the user's message.
- If the user writes in Arabic, answer in Arabic.
- If the user writes in Spanish, answer in Spanish.
- If the user writes in English, answer in English.
- And so on for any other language.
- If the user only says "hello" or a greeting, respond with a friendly greeting
and ask them to describe their car issue.
- Your answers must be:
1) Short summary
2) Most likely causes (bullet list)
3) What the user can check now (bullet list)
4) Safety / when to stop driving (if relevant)
5) Professional next step

VEHICLE CONTEXT:
- You are specialized in cars (engine, suspension, brakes, steering, electronics).
- You are **not** a replacement for a professional mechanic.
Always remind the user to visit a mechanic for a final diagnosis if the issue is serious.
`;
}

async function handleTextMode(body) {
const message = (body.message || "").trim();
if (!message) {
return {
status: 400,
json: { code: 400, message: "No message provided for diagnosis." },
};
}

const systemPrompt = buildSystemPrompt();

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: message,
},
],
temperature: 0.6,
});

const diagnosis = completion.choices[0]?.message?.content?.trim() || "";

return {
status: 200,
json: {
code: 200,
mode: "text",
diagnosis,
},
};
}

async function handleImageMode(body) {
const imageUrl = (body.imageUrl || body.image_url || "").trim();
const userText = getUserTextFromBody(body);

if (!imageUrl) {
return {
status: 400,
json: { code: 400, message: "No image URL provided for diagnosis." },
};
}

const systemPrompt = buildSystemPrompt();

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: [
{
type: "text",
text:
(userText && userText.length > 0
? `The user wrote: "${userText}". Use the **same language** as this text.\n`
: "The user sent a photo about a car issue. Use the most likely language from any text you see.\n") +
"Analyze what might be wrong with the car based on this photo.",
},
{
type: "image_url",
image_url: {
url: imageUrl,
},
},
],
},
],
temperature: 0.6,
});

const diagnosis = completion.choices[0]?.message?.content?.trim() || "";

return {
status: 200,
json: {
code: 200,
mode: "image",
diagnosis,
},
};
}

async function handleAudioMode(body) {
// 👂 في هذا الإصدار نفترض أن تطبيق Flutter يرسل نص مفرغ للصوت
// تحت المفتاح audioTranscription (أي كلام المستخدم عن الصوت)
const transcription = (body.audioTranscription || "").trim();
if (!transcription) {
return {
status: 400,
json: {
code: 400,
message:
"No audio transcription provided for diagnosis. Please send 'audioTranscription' as text.",
},
};
}

const systemPrompt = buildSystemPrompt();

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: `
The user recorded a car sound. This is the transcription or description:

"${transcription}"

Explain what the sound might indicate and follow the same structure (summary, causes, checks, safety, next step).
`,
},
],
temperature: 0.6,
});

const diagnosis = completion.choices[0]?.message?.content?.trim() || "";

return {
status: 200,
json: {
code: 200,
mode: "audio",
diagnosis,
},
};
}

// ==================
// Next.js / Vercel API handler
// ==================
export default async function handler(req, res) {
try:
if (req.method !== "POST") {
return res
.status(405)
.json({ code: 405, message: "Method not allowed. Use POST." });
}

const body = req.body || {};
const mode = (body.mode || "text").toLowerCase();

let result;

if (mode === "text") {
result = await handleTextMode(body);
} else if (mode === "image") {
result = await handleImageMode(body);
} else if (mode === "audio") {
result = await handleAudioMode(body);
} else {
return res.status(400).json({
code: 400,
message: `Unknown mode "${mode}". Use "text", "image", or "audio".`,
});
}

return res.status(result.status).json(result.json);
} catch (err) {
console.error("FixLens Brain – diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
});
}
}
