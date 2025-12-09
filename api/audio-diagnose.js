// api/audio-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { logFixLensEvent } from "../lib/supabaseClient.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

function guessLanguage(text) {
if (!text || !text.trim()) return null;
const t = text.trim();

if (/[\u0600-\u06FF]/.test(t)) return "ar";
if (/[\u0400-\u04FF]/.test(t)) return "ru";
if (/[\u0370-\u03FF]/.test(t)) return "el";
if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

const lower = t.toLowerCase();

if (/[ñáéíóúü]|hola\b|gracias\b|buenos\s+d[ií]as/.test(lower)) return "es";
if (/[àâçéèêëîïôùûüÿœ]|bonjour\b|merci\b/.test(lower)) return "fr";
if (/[äöüß]|hallo\b|danke\b/.test(lower)) return "de";

if (/^[\x00-\x7F]+$/.test(t)) return "en";

return null;
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "Method not allowed" });
}

const started = Date.now();

try {
const body =
typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const audioBase64 = body.audioBase64;
const mimeType = body.mimeType || "audio/m4a";
const languageHint = body.language || "auto";
const mode = "audio";

if (!audioBase64) {
return res
.status(400)
.json({ code: 400, message: "audioBase64 is required." });
}

// 1) تحويل الصوت إلى نص
const audioBuffer = Buffer.from(audioBase64, "base64");

const transcription = await openai.audio.transcriptions.create({
model: "gpt-4o-mini-transcribe",
file: {
data: audioBuffer,
name: `voice-note.${mimeType.split("/")[1] || "m4a"}`,
},
// نخلي اللغة auto حتى يتعرف على العربية / الإسبانية / ...
});

const transcriptText = (transcription.text || "").trim();

if (!transcriptText) {
return res.status(200).json({
code: 200,
message: "OK",
reply:
"I'm sorry, I couldn't understand your voice note clearly. Could you please repeat or type out the issue you're experiencing? This will help me assist you better.",
});
}

const autoKnowledge = findRelevantIssues(transcriptText);

let targetLanguage = null;
if (languageHint && languageHint !== "auto") {
targetLanguage = languageHint;
} else {
targetLanguage = guessLanguage(transcriptText) || "en";
}

const languageInstruction =
targetLanguage === "en"
? "Reply in natural English, unless the transcript is clearly in another language."
: `Reply strictly in this language: ${targetLanguage}.`;

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for cars, home appliances, and general mechanical issues.

Language rule:
- ${languageInstruction}
- NEVER switch to another language unless the user clearly switches.
- If the transcript is in Arabic, answer fully in Arabic. If Spanish, answer in Spanish, etc.

General rules:
- The user has described a problem by voice. Use the transcript below as the user's message.
- Follow the structure:
- **Quick Summary**
- **Most Likely Causes**
- **What You Can Check Now**
- **Safety / When to Stop Driving or Using the device**
- **Next Professional Step**
- Ask 2–3 smart follow-up questions if needed.
- Be honest about uncertainty and give safety warnings when needed.
${autoKnowledge ? "\nInternal hints:\n" + autoKnowledge : ""}

Transcript:
"""${transcriptText}"""
`;

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: "Please provide your diagnosis and advice." },
],
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

const latencyMs = Date.now() - started;

logFixLensEvent({
source: "mobile-app",
mode,
userMessage: transcriptText,
aiReply: reply,
meta: {
endpoint: "/api/audio-diagnose",
languageHint,
targetLanguage,
model: "gpt-4.1-mini",
transcriptionModel: "gpt-4o-mini-transcribe",
latencyMs,
success: true,
},
}).catch(() => {});

return res.status(200).json({
code: 200,
message: "OK",
reply,
language: targetLanguage,
});
} catch (err) {
console.error("FixLens Brain audio-diagnose error:", err);

const latencyMs = Date.now() - started;
logFixLensEvent({
source: "mobile-app",
mode: "audio",
userMessage: null,
aiReply: null,
meta: {
endpoint: "/api/audio-diagnose",
error: err?.message || String(err),
latencyMs,
success: false,
},
}).catch(() => {});

return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
