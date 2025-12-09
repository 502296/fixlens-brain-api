// api/audio-diagnose.js
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const apiKey = process.env.OPENAI_API_KEY || "";

const openai = new OpenAI({
apiKey,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ code: 405, message: "Method not allowed" });
}

try {
const body =
typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const audioBase64 = body.audioBase64 || body.audio || "";
const mimeType = body.mimeType || "audio/m4a";
const note = body.note || "";
const languageHint = body.language || "auto";
const mode = "audio";

if (!audioBase64 || !audioBase64.trim()) {
return res.status(400).json({
code: 400,
message: "audioBase64 is required.",
});
}

if (!apiKey) {
return res.status(500).json({
code: 500,
message:
"OPENAI_API_KEY is not configured on the server. Please add it in Vercel Environment Variables.",
});
}

// 1) نحول الـ base64 إلى ملف مؤقت لاستخدامه مع Whisper
const extension =
mimeType.split("/")[1]?.split(";")[0] || "m4a";

const audioFile = await toFile(
Buffer.from(audioBase64, "base64"),
`voice.${extension}`
);

// 2) نستخدم Whisper (gpt-4o-mini-transcribe) لتحويل الصوت إلى نص
const transcription =
await openai.audio.transcriptions.create({
file: audioFile,
model: "gpt-4o-mini-transcribe",
});

const transcriptText =
transcription.text?.trim() || "";

if (!transcriptText) {
return res.status(200).json({
code: 200,
message: "OK",
reply:
"I received your voice note but could not understand the audio clearly. Please try again or describe the problem in text.",
});
}

// نستخدم الـ transcript + الملاحظة (إن وجدت)
let userCombinedText = transcriptText;
if (note && note.trim().length > 0) {
userCombinedText = `${note.trim()}\n\nVoice note transcript:\n${transcriptText}`;
}

let autoKnowledgeText = null;
try {
autoKnowledgeText = findRelevantIssues(userCombinedText);
} catch (err) {
console.error("autoKnowledge (audio) error:", err);
autoKnowledgeText = null;
}

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant.

You will receive:
- A transcription of the user's voice note
- Optional extra note they typed

Rules:
- ALWAYS reply in the SAME LANGUAGE as the transcription (or note).
- First, confirm briefly that you understood the voice note.
- Then give a clear step-by-step diagnostic plan.
- Use mechanic thinking for car issues, and appliance/technical thinking for other issues.
- Give safety warnings when appropriate.
`;

const messages = [
{ role: "system", content: systemPrompt },
autoKnowledgeText
? { role: "system", content: autoKnowledgeText }
: null,
{
role: "user",
content: userCombinedText,
},
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

// ============ Supabase logging (اختياري وآمن) ============
try {
const supaModule = await import("../lib/supabaseClient.js");
const logFixLensEvent = supaModule.logFixLensEvent;

if (typeof logFixLensEvent === "function") {
await logFixLensEvent({
source: "mobile-app",
mode,
userMessage: userCombinedText,
aiReply: reply,
meta: {
languageHint,
model: "gpt-4.1-mini",
hasAudio: true,
},
});
}
} catch (logErr) {
console.error("Supabase audio log error (ignored):", logErr);
}
// =========================================================

return res.status(200).json({
code: 200,
message: "OK",
reply,
});
} catch (err) {
console.error("FixLens Brain audio-diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
