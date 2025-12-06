// api/audio-diagnose.js
// FixLens Auto – FULL audio pipeline (base64 audio)
// 1) Receive base64 audio from the app
// 2) Transcribe using OpenAI Audio (Whisper-compatible)
// 3) Run full diagnosis using the same logic as text diagnose

import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe"; // عدّلها إذا عندك موديل آخر

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
const { audioBase64, languageHint } = req.body || {};

if (!audioBase64) {
return res.status(400).json({
error:
"Missing 'audioBase64' in request body. Please send base64-encoded audio.",
});
}

// 1) تحويل الـ base64 إلى Buffer
const audioBuffer = Buffer.from(audioBase64, "base64");

// 2) تجهيز FormData لطلب الـ transcription
const formData = new FormData(); // متوفرة في Node 18 على Vercel
formData.append("file", new Blob([audioBuffer]), "audio.m4a");
formData.append("model", TRANSCRIBE_MODEL);
if (languageHint && typeof languageHint === "string") {
formData.append("language", languageHint); // "ar", "en", ...
}

const sttRes = await fetch(
"https://api.openai.com/v1/audio/transcriptions",
{
method: "POST",
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
},
body: formData,
}
);

if (!sttRes.ok) {
const errText = await sttRes.text();
console.error("OpenAI transcription error:", errText);
return res.status(500).json({
error: "Transcription error",
details: errText,
});
}

const sttData = await sttRes.json();
const transcript = (sttData?.text || "").trim();

if (!transcript) {
// لو ما قدر يفهم الصوت، نطلب من المستخدم يكتب الوصف
return res.status(200).json({
answer:
"I received your voice note but couldn’t clearly understand the audio. Please type a short description of your car issue so I can help you with a proper diagnosis.",
});
}

// 3) نستخدم النص الناتج من الصوت كـ description
let kbMatches = [];
try {
kbMatches = findMatchingIssues(transcript, 5);
} catch (err) {
console.error("Error loading knowledge base:", err);
kbMatches = [];
}

const systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostician.

You receive:
- A transcription of the driver's voice note describing the issue.
- A small JSON "knowledge base" of common automotive issues.

Language rules:
- Detect the language of the driver's description.
- If you receive a language hint from the app, you may use it as a hint.
- ALWAYS answer in the **same language** the driver used.
- Keep the tone clear, friendly, and professional.

Diagnostic rules:
1. Use the JSON knowledge base as a starting point if any items match the symptoms.
2. Combine that with your broader professional experience.
3. Always:
- Start with a short, clear title line.
- Then "Most likely causes" as a bullet list.
- Then "What to check now" as a bullet list.
- If there is any safety risk, include a final "Safety note:" line.
4. Do NOT mention JSON, the word "knowledge base", or that you are an AI model.
`;

const kbText =
kbMatches.length > 0
? JSON.stringify(kbMatches, null, 2)
: "No strong matches from the built-in knowledge base.";

const userPrompt = `
Transcribed driver description (from voice note):
${transcript}

Top internal knowledge base matches (for you to consider):
${kbText}

Now, give the best diagnostic explanation you can, following the required format and replying in the SAME language as the driver's description.
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
console.error("OpenAI diagnose-from-audio error:", errText);
return res.status(500).json({
error: "FixLens Brain error (from audio)",
details: errText,
});
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a diagnosis at the moment.";

// ✅ نرجّع دائماً answer + transcript
return res.status(200).json({ answer: reply, transcript });
} catch (err) {
console.error("audio-diagnose handler error:", err);
return res.status(500).json({
error: "Server error in audio-diagnose",
details: String(err),
});
}
}
