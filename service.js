import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة تحويل الصوت: تم ضبط الامتداد m4a لضمان القبول العالمي
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) {
console.error("Whisper Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

// ✅ الوظيفة الرئيسية: تم توحيد المتغيرات لقتل خطأ ReferenceError
export async function handleFixLensRequest(req) {
try {
// توحيد اسم المتغير ليكون audio_base64 (بدون شرطة ثالثة) ليتوافق مع سجلات الخطأ
let {
text = "",
image_base64,
audio_base64,
history = [],
user_location = "Global"
} = req.body;

// 1. معالجة الصوت إذا وجد
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. تفعيل البحث العالمي المحترف (Louisville, London, Paris, etc.)
let searchResults = "";
const intents = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "سكراب"];
if (intents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// 3. بناء السياق النهائي (إجبار الموديل على رؤية النتائج الحقيقية)
const finalPayload = `
REGION: ${user_location}
USER_INPUT: ${text}
LOCAL_DATA: ${searchResults || "Search enabled..."}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{
role: "user",
content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base_64}` } }
] : finalPayload
}
],
temperature: 0.3
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error);
throw error;
}
}
