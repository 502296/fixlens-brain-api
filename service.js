import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensRequest(req) {
try {
let { text = "", locale, image_base64, audio_base64 } = req.body;

// 1. أذن الدكتور (Whisper)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `${text} [User Voice Note]: ${voiceText}`.trim();
}

// 2. كشف اللغة التلقائي
if (!locale || locale === "auto") {
locale = /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
}

// 3. البحث العالمي والمحلي (RAG)
const kb = buildKnowledgeSnippets(text);
const finalPrompt = `User Query: ${text}\n\n[SYSTEM DATABASE]:\n${kb}\n\nAnalyze all inputs (Text/Voice/Image) and respond as Dr. FixLens.`;

// 4. التشخيص (Vision or Text)
if (image_base64) {
return await analyzeWithVision(finalPrompt, locale, image_base64);
}
return await analyzeWithText(finalPrompt, locale);

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}

async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.mp3`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

async function analyzeWithText(userText, locale) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{ role: "user", content: userText },
],
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(userText, locale, base64Image) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{
role: "user",
content: [
{ type: "text", text: userText },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}
