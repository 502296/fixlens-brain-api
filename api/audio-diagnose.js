// api/audio-diagnose.js
// Analyze engine / car sounds from audio + respond في نفس لغة المستخدم

import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { audioBase64, preferredLanguage } = req.body || {};

if (!audioBase64 || typeof audioBase64 !== "string") {
return res.status(400).json({
error: "Field 'audioBase64' (base64 audio) is required.",
});
}

// نحفظ الصوت مؤقتاً في /tmp حتى يستخدمه Whisper
const audioBuffer = Buffer.from(audioBase64, "base64");
const tmpPath = path.join(
os.tmpdir(),
`fixlens-audio-${Date.now()}.m4a`
);
fs.writeFileSync(tmpPath, audioBuffer);

// 1) Transcribe – نحصل نص + لغة
const transcription = await client.audio.transcriptions.create({
file: fs.createReadStream(tmpPath),
model: "gpt-4o-mini-transcribe",
});

fs.unlink(tmpPath, () => {});

const userText = transcription.text || "";
const detectedLang = transcription.language || "";

const langNote =
preferredLanguage && preferredLanguage !== "auto"
? `Reply ONLY in the language code: ${preferredLanguage}.`
: detectedLang
? `Reply in the same language as this text (language code: ${detectedLang}).`
: "Reply in the same language as the user's description, or English if unclear.";

const prompt =
"You are FixLens Auto, an expert mechanic focused on diagnosing car issues from sounds and vibrations.\n\n" +
"The user recorded a sound from their vehicle. Here is the transcription of what is audible / said:\n" +
`"${userText}"\n\n` +
"Based only on the sound characteristics and any hints in the transcription, do ALL of the following:\n" +
"- Describe what the sound is like (for example: knocking, squeaking, grinding, whining, rattling, etc.).\n" +
"- List a few *possible* causes (bulleted list).\n" +
"- Explain whether driving is likely safe or risky.\n" +
"- Suggest simple things the user can check or pay attention to before visiting a mechanic.\n" +
"- End with a short, friendly reminder that this is not a final professional diagnosis.\n\n" +
langNote;

const response = await client.responses.create({
model: "gpt-4.1-mini",
input: [
{
role: "user",
content: [{ type: "input_text", text: prompt }],
},
],
});

let replyText =
"I analyzed the sound, but I couldn't generate a detailed explanation.";
try {
const first = response.output[0];
const firstContent = first?.content?.[0];
if (firstContent?.type === "output_text") {
replyText = firstContent.text;
}
} catch (err) {
console.error("Parse audio response error:", err);
}

return res.status(200).json({
reply: replyText,
language: preferredLanguage || detectedLang || "auto",
mode: "audio",
domain: "auto",
});
} catch (err) {
console.error("audio-diagnose internal error:", err);
return res.status(500).json({
error: "Internal error in audio-diagnose",
details: String(err),
});
}
}
