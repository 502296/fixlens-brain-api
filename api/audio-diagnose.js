// api/audio-diagnose.js
// Advanced audio diagnosis: audio -> transcription -> full FixLens Auto diagnosis

import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";
const TRANSCRIPTION_MODEL =
process.env.FIXLENS_TRANSCRIBE_MODEL || "whisper-1";

if (!global.FormData) {
// Node 18+ عنده FormData و Blob بشكل افتراضي، لكن نحط هذا احتياطاً
// eslint-disable-next-line no-global-assign
global.FormData = require("form-data");
}

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
const { audioBase64, mimeType, languageHint } = req.body || {};

if (!audioBase64) {
return res.status(400).json({
error:
"Missing 'audioBase64' in request body. Please send the recorded audio as base64.",
});
}

// 1) نحول الـ base64 إلى Buffer
const audioBuffer = Buffer.from(audioBase64, "base64");

// 2) نرسل الصوت إلى Whisper لعمل Transcription
const formData = new FormData();
formData.append(
"file",
new Blob([audioBuffer], {
type: mimeType || "audio/m4a",
}),
"voice.m4a"
);
formData.append("model", TRANSCRIPTION_MODEL);

// لو حاب تعطي Hint للغة (مثلاً "ar", "en", "es")
if (languageHint) {
formData.append("language", languageHint);
}

const whisperRes = await fetch(
"https://api.openai.com/v1/audio/transcriptions",
{
method: "POST",
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
},
body: formData,
}
);

if (!whisperRes.ok) {
const errText = await whisperRes.text();
console.error("Whisper error:", errText);
return res.status(500).json({
error: "Audio transcription failed",
details: errText,
});
}

const whisperData = await whisperRes.json();
const transcript =
whisperData?.text?.trim() ||
"The audio was received but produced an empty transcription.";

console.log("FixLens – audio transcript:", transcript);

// 3) نستخدم الـ transcript كـ description وندخل على نفس منطق التشخيص

let kbMatches = [];
try {
kbMatches = findMatchingIssues(transcript, 5);
} catch (err) {
console.error("Error loading knowledge base:", err);
kbMatches = [];
}

const systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostician working in audio mode.

You receive:
- A driver's spoken description of a car problem (already transcribed into text).
- A small JSON "knowledge base" of common automotive issues.

Language rules:
1. Detect the main language of the transcribed description (for example: English, Arabic, Spanish, French, etc.).
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
Transcribed driver audio description:
${transcript}

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
console.error("OpenAI (audio diagnose) error:", errText);
return res.status(500).json({
error: "FixLens Brain audio error",
details: errText,
});
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate an audio-based diagnosis at the moment.";

return res.status(200).json({
transcript,
reply,
});
} catch (err) {
console.error("audio-diagnose handler error:", err);
return res.status(500).json({
error: "Server error",
details: String(err),
});
}
}
