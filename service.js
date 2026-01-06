import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* 🎙️ Professional Audio Processor
* Fixes: Variable naming and supported file extensions.
*/
async function transcribeAudio(audioBase64) {
// استخدام امتداد .m4a لضمان التوافق العالمي
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) {
console.error("Whisper Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* 🚀 Global Mechanical Intelligence Handler
*/
export async function handleFixLensRequest(req) {
try {
// تصحيح استلام المتغيرات لضمان التوافق مع تطبيق الموبايل
let {
text = "",
image_base64,
audio_base64, // الاسم الصحيح ليتوافق مع سجلات الخطأ
history = [],
user_location = "Global"
} = req.body;

// 1. معالجة وحقن الصوت كأولوية هندسية
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) {
text = `[AUDITORY DATA]: "${voiceText}". ${text}`.trim();
}
}

// 2. تفعيل البحث العالمي المحترف بناءً على الموقع
let searchResults = "";
const searchIntents = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "محل"];
if (searchIntents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// 3. بناء السياق النهائي المحترف
const finalPayload = `
[GLOBAL_PROTOCOL]: Professional Master Mechanic Analysis.
[REGION]: ${user_location}
[TECHNICAL_ANALYSIS]: ${text}
[LOCAL_DATA]: ${searchResults || "Search results pending..."}
`.trim();

// 4. استدعاء الموديل (GPT-4o)
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{
role: "user",
content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload
}
],
temperature: 0.3, // دقة تقنية عالية
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error);
throw error;
}
}
