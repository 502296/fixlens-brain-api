// api/audio-diagnose.js
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { logFixLensEvent } from "../lib/supabaseClient.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "Method not allowed" });
}

try {
const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const audioBase64 = body.audioBase64;
const mimeType = body.mimeType || "audio/m4a";
const userNote = body.note || "";

if (!audioBase64) {
return res
.status(400)
.json({ code: 400, message: "audioBase64 required." });
}

// نحفظ الملف مؤقتاً في /tmp
const buffer = Buffer.from(audioBase64, "base64");
const tmpDir = "/tmp";
const filePath = path.join(tmpDir, `fixlens-audio-${Date.now()}.m4a`);
fs.writeFileSync(filePath, buffer);

// 1) تحويل الصوت إلى نص
const transcriptResp = await openai.audio.transcriptions.create({
file: fs.createReadStream(filePath),
model: "gpt-4o-mini-transcribe",
response_format: "json",
language: "auto",
});

const transcript = transcriptResp.text?.trim() || "";

// نمسح الملف المؤقت
try {
fs.unlinkSync(filePath);
} catch (_) {}

if (!transcript) {
return res.status(200).json({
code: 200,
message: "OK",
transcript: "",
reply:
"FixLens could not clearly understand the audio. Please try again with a closer recording or add a text description.",
});
}

const autoKnowledge = findRelevantIssues(transcript);

const systemPrompt = `
You are FixLens Brain – an audio diagnostic assistant.
User just recorded a sound from a car or mechanical system.

Rules:
- First, summarize what the noise sounds like (rhythm, pitch, pattern).
- Then suggest 2–3 possible causes and what the user should check.
- Use internal knowledge if provided.
- Reply in the same language as the user if possible.
`;

const messages = [
{ role: "system", content: systemPrompt },
autoKnowledge
? {
role: "system",
content: autoKnowledge,
}
: null,
userNote
? { role: "user", content: `Extra note from user: ${userNote}` }
: null,
{
role: "user",
content: `Here is the transcription of the noise: "${transcript}"`,
},
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.4,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

logFixLensEvent({
source: "mobile-app",
mode: "audio",
userMessage: transcript,
aiReply: reply,
meta: { mimeType },
}).catch(() => {});

return res.status(200).json({
code: 200,
message: "OK",
transcript,
reply,
});
} catch (err) {
console.error("FixLens Brain audio-diagnose error:", err);
return res
.status(500)
.json({ code: 500, message: "A server error has occurred" });
}
}
