import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* المعالج الرئيسي لطلبات FixLens - نسخة "الدكتور المحترف"
*/
export async function handleFixLensRequest(req) {
try {
let { text, locale, image_base64, audio_base64 } = req.body;

// 1. معالجة الصوت (Whisper) إذا وجد
if (audio_base64) {
const transcribedText = await transcribeAudio(audio_base64);
if (transcribedText) {
text = text ? `${text} (ملاحظة صوتية: ${transcribedText})` : transcribedText;
}
}

// 2. الكشف الذكي عن اللغة
if (!locale) {
const isArabic = /[\u0600-\u06FF]/.test(text || "");
locale = isArabic ? "ar" : "en";
}

// 3. جلب المعرفة المحلية (RAG)
const kb = buildKnowledgeSnippets(text || "");
const enrichedUserText = text
? `${text}\n\n[CONTEXT DATA]:\n${kb}`
: `Analyze the attached media. [CONTEXT DATA]:\n${kb}`;

// 4. توجيه الطلب بناءً على نوع المرفقات
if (image_base64) {
return await analyzeWithVision(enrichedUserText, locale, image_base64);
}

return await analyzeWithText(enrichedUserText, locale);

} catch (error) {
console.error("CRITICAL_ERROR in handleFixLensRequest:", error);
throw error;
}
}

/**
* تحويل الصوت إلى نص باستخدام Whisper
*/
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.mp3`);
try {
const buffer = Buffer.from(audioBase64, "base64");
fs.writeFileSync(tempPath, buffer);

const transcription = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});

return transcription.text;
} catch (err) {
console.error("Audio Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* تحليل النصوص (GPT-4o)
*/
async function analyzeWithText(userText, locale) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{ role: "user", content: userText },
],
temperature: 0.7,
});
return { ok: true, reply: response.choices[0].message.content, engine: "gpt-4o-text" };
}

/**
* تحليل الصور (GPT-4o Vision)
*/
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
return { ok: true, reply: response.choices[0].message.content, engine: "gpt-4o-vision" };
}
