import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة معالجة الصوت ( Whisper)
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `audio_${Date.now()}.mp3`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) {
console.error("Audio Engine Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

// ✅ تصدير الوظيفة الرئيسية (تأكد من وجود كلمة export)
export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "USA"
} = req.body;

// حقن الصوت بذكاء
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `[Observation]: ${voiceText}. ${text}`.trim();
}

const internalKB = buildKnowledgeSnippets(text);
// تفعيل البحث المحلي بناءً على SERPAPI_KEY المحدث في صورك
let searchResults = "";
if (["shop", "repair", "parts", "ورشة"].some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// صياغة المدخلات بأسلوب تقني بحت (بعيداً عن المصطلحات المحظورة)
const technicalInput = `
Region: ${user_location}
User Input: ${text}
Manuals: ${internalKB}
Local Options: ${searchResults}
`.trim();

if (image_base64) {
return await analyzeWithVision(technicalInput, locale, image_base64, history);
}
return await analyzeWithText(technicalInput, locale, history);

} catch (error) {
console.error("FixLens Execution Error:", error);
throw error;
}
}

// دالات التحليل (بدرجة حرارة منخفضة للدقة التقنية)
async function analyzeWithText(input, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{ role: "user", content: input },
],
temperature: 0.3,
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(input, locale, base64Image, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{
role: "user",
content: [
{ type: "text", text: input },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}
