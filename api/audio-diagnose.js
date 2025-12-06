// api/audio-diagnose.js
// FixLens Auto – FINAL MULTILINGUAL AUDIO DIAGNOSIS

import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";
const STT_MODEL = "gpt-4o-mini-transcribe";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

if (!OPENAI_API_KEY) {
return res.status(500).json({
error: "Missing OPENAI_API_KEY.",
});
}

try {
const { audioBase64, languageHint } = req.body || {};

if (!audioBase64) {
return res.status(400).json({
error: "Missing 'audioBase64'. Please send base64 audio.",
});
}

const audioBuffer = Buffer.from(audioBase64, "base64");

const formData = new FormData();
formData.append("file", new Blob([audioBuffer]), "audio.m4a");
formData.append("model", STT_MODEL);
if (languageHint) {
formData.append("language", languageHint);
}

// --- TRANSCRIBE ---
const sttRes = await fetch(
"https://api.openai.com/v1/audio/transcriptions",
{
method: "POST",
headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
body: formData,
}
);

if (!sttRes.ok) {
const err = await sttRes.text();
console.error("Transcription Error:", err);
return res.status(500).json({ error: "Transcription failed", details: err });
}

const sttData = await sttRes.json();
const transcript = sttData?.text?.trim() || "";

if (!transcript) {
return res.status(200).json({
reply:
"I received your audio but couldn't understand it clearly. Please type a short description.",
});
}

let kbMatches = [];
try {
kbMatches = findMatchingIssues(transcript, 5);
} catch (_) {}

const systemPrompt = `
You are FixLens Auto — a multilingual car diagnostic expert.
You ALWAYS answer in the same language as the driver.
Use the knowledge base when relevant.
Follow the exact format:
- Title
- Most likely causes
- What to check now
- Safety note (if needed)
`;

const userPrompt = `
Voice note transcription:
${transcript}

Knowledge base matches:
${kbMatches.length ? JSON.stringify(kbMatches, null, 2) : "None"}

Give the best diagnosis now.
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
model: MODEL,
temperature: 0.4,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
],
}),
}
);

if (!openaiRes.ok) {
const err = await openaiRes.text();
console.error("OpenAI Audio Diagnose Error:", err);
return res.status(500).json({ error: "FixLens Brain error", details: err });
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I could not generate a diagnosis.";

return res.status(200).json({ reply, transcript });
} catch (err) {
console.error("audio-diagnose fatal error:", err);
return res.status(500).json({
error: "Internal error",
details: String(err),
});
}
}
