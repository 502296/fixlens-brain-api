import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
// استيراد وظيفة البحث الخاصة بك
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensRequest(req) {
try {
// استقبال البيانات من الموبايل (نص، لغة، صورة، صوت، تاريخ، وموقع)
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "Global/Unknown"
} = req.body;

// 1. تحويل الصوت إلى نص (Whisper AI)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `${text} [User Voice Note]: ${voiceText}`.trim();
}

// 2. البحث الذكي (RAG + Web/Local Search)
// أولاً: جلب المعلومات من قاعدة بياناتك المحلية
const internalKB = buildKnowledgeSnippets(text);
// ثانياً: إذا كان المستخدم يسأل عن ورش أو محلات، نستخدم ملف search.js
let searchResults = "";
if (text.toLowerCase().includes("shop") || text.toLowerCase().includes("workshop") || text.includes("محل") || text.includes("ورشة")) {
searchResults = await performSearch(text, user_location);
}

// 3. تجهيز البرومبت النهائي المدمج
const finalContext = `
[USER CONTEXT]:
- Location: ${user_location}
- Current Query: ${text}

[TECHNICAL DATA]:
${internalKB}

[LOCAL SEARCH RESULTS]:
${searchResults}

Please generate a professional diagnostic report based on the above.`;

// 4. إرسال الطلب لـ GPT-4o (مع دعم الصور والتاريخ)
if (image_base64) {
return await analyzeWithVision(finalContext, locale, image_base64, history);
}
return await analyzeWithText(finalContext, locale, history);

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}

// دالة تحليل النصوص مع التاريخ (History)
async function analyzeWithText(payload, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history, // دمج التاريخ ليتذكر المحادثة
{ role: "user", content: payload },
],
temperature: 0.7,
});
return { ok: true, reply: response.choices[0].message.content };
}

// دالة تحليل الصور مع النصوص والتاريخ
async function analyzeWithVision(payload, locale, base64Image, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{
role: "user",
content: [
{ type: "text", text: payload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } },
],
},
],
max_tokens: 1500,
});
return { ok: true, reply: response.choices[0].message.content };
}

// دالة تحويل الصوت
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.mp3`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) {
console.error("Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}
