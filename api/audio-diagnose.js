// api/audio-diagnose.js
// FixLens Auto – Audio diagnosis endpoint
// 1) يستقبل audioBase64 من التطبيق
// 2) يحوّله إلى ملف ويرسله إلى OpenAI Transcribe
// 3) يأخذ النص الناتج ويعمل نفس منطق التشخيص مثل diagnose.js

import { findMatchingIssues } from "../lib/autoKnowledge.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL =
process.env.FIXLENS_MODEL || "gpt-4.1-mini";

// موديل تحويل الصوت إلى نص
const TRANSCRIBE_MODEL =
process.env.FIXLENS_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

/**
* يحوّل base64 (مع أو بدون data:...) إلى Buffer
*/
function base64ToBuffer(base64) {
if (!base64) return null;
// لو كان بهذه الصيغة: data:audio/webm;base64,AAAA...
const clean = base64.includes(",") ? base64.split(",").pop() : base64;
return Buffer.from(clean, "base64");
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
"Missing audioBase64 in request body. Cannot analyze audio without data.",
});
}

// 1) تحويل base64 إلى Blob + FormData للـ /audio/transcriptions
const audioBuffer = base64ToBuffer(audioBase64);
if (!audioBuffer) {
return res.status(400).json({
error: "Could not decode audioBase64.",
});
}

// في Runtime الحديث (Vercel / Node 18+) يوجد Blob و FormData بشكل افتراضي
const blob = new Blob([audioBuffer], {
type: mimeType || "audio/webm",
});

const formData = new FormData();
formData.append("file", blob, "fixlens-audio.webm");
formData.append("model", TRANSCRIBE_MODEL);

// لو تحب تعطي تلميح لغة (مثلاً "ar" أو "en")
if (languageHint) {
formData.append("language", languageHint);
}

// 2) استدعاء OpenAI Transcribe
const transcribeRes = await fetch(
"https://api.openai.com/v1/audio/transcriptions",
{
method: "POST",
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
// لا نضع Content-Type هنا، FormData يضبطها تلقائياً
},
body: formData,
}
);

if (!transcribeRes.ok) {
const errText = await transcribeRes.text();
console.error("Transcription error:", errText);

return res.status(500).json({
error: "FixLens Brain transcription error",
details: errText,
});
}

const transcribeData = await transcribeRes.json();
const transcript =
(transcribeData && transcribeData.text && transcribeData.text.trim()) ||
"";

if (!transcript) {
return res.status(500).json({
error: "Transcription succeeded but returned empty text.",
});
}

// 3) نستخدم النص الناتج ونطبّق عليه نفس منطق diagnose.js
let kbMatches = [];
try {
kbMatches = findMatchingIssues(transcript, 5);
} catch (err) {
console.error("Error loading knowledge base (audio):", err);
kbMatches = [];
}

const kbText =
kbMatches.length > 0
? JSON.stringify(kbMatches, null, 2)
: "No strong matches from the built-in knowledge base.";

const systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostician.

You receive:
- The driver's description of the issue (converted from a voice note).
- A small JSON 'knowledge base' of common automotive issues.

Language rules:
- First, detect the language of the driver's description.
- ALWAYS answer in the *same language* the driver used (Arabic in = Arabic out, English in = English out, etc.).
- Keep the tone clear, friendly, and professional.

Diagnostic rules:
1. Use the JSON knowledge base as a starting point if any items match the symptoms.
2. Combine that with your broader professional experience.
3. Always:
- Start with a short, clear title line summarizing the issue.
- Then "Most likely causes" as a bullet list.
- Then "What to check now" as a bullet list the driver or mechanic can actually do.
- If there is any safety risk, include a final line: "Safety note:" with clear advice.
4. Do NOT mention JSON, the word "knowledge base", or that you are an AI model.
`;

const userPrompt = `
Driver description (transcribed from voice note):
${transcript}

Top internal knowledge base matches (for you to consider):
${kbText}

Now, give the best diagnostic explanation you can, following the required format and replying in the same language as the driver.
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
console.error("OpenAI chat error (audio):", errText);
return res.status(500).json({
error: "FixLens Brain error",
details: errText,
});
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a diagnosis at the moment.";

// نرجع الـ reply للنظام (Flutter)
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
