import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* ✅ تحسين Whisper: إضافة 'prompt' تقني لإجبار الموديل على التعرف على أصوات المحرك
* مثل (Squealing, Knocking, Ticking) بدلاً من تجاهلها كضوضاء.
*/
async function transcribeAudio(audioBase64) {
if (!audioBase64) return null;

const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
// 💡 التعديل الجوهري: توجيه الموديل تقنياً
prompt: "Mechanical diagnostic: engine knocking, squealing belt, hissing, grinding, clicking, ticking."
});
return result.text;
} catch (err) {
console.error("Whisper Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
// ✅ ضمان استلام جميع المتغيرات وتجنب ReferenceError
const {
text = "",
image_base64 = null,
audio_base_64 = null, // التأكد من مطابقة الاسم المرسل من الـ Frontend
history = [],
user_location = "Global"
} = req.body;

let processedText = text;

// 1. معالجة الصوت بذكاء تقني
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) {
// دمج النص الصوتي مع النص المكتوب لتعزيز الدقة
processedText = `[USER AUDIO DESCRIPTION]: "${voiceText}". ${text}`.trim();
}
}

// 2. البحث المحلي المتقدم (يدعم الإنجليزية والعربية)
let searchResults = "";
const searchKeywords = ["shop", "parts", "repair", "ورشة", "قطع غيار", "تصليح", "ميكانيكي"];
if (searchKeywords.some(k => processedText.toLowerCase().includes(k))) {
searchResults = await performSearch(processedText, user_location);
}

// 3. إعداد الـ Payload ليكون متوافقاً مع GPT-4o بجميع اللغات
const finalPayload = `
[LOCATION]: ${user_location}
[INTENT]: Diagnostic & Support
[USER_MSG]: ${processedText}
[LOCAL_RESOURCES]: ${searchResults || "No local data needed for this query."}
`.trim();

// 4. استدعاء الموديل مع دعم الرد بنفس لغة المستخدم (Multi-language support)
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()} \nIMPORTANT: Always respond in the SAME LANGUAGE the user is using (Arabic, English, Spanish, etc.). Be direct and professional.`
},
...history.slice(-4), // زيادة السياق لـ 4 رسائل لضمان ترابط الحوار
{
role: "user",
content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base_64}` } }
] : finalPayload
}
],
temperature: 0.2 // تقليل الحرارة لزيادة الدقة التقنية
});

return {
ok: true,
reply: response.choices[0].message.content
};

} catch (error) {
console.error("FixLens Backend Critical Error:", error.message);
return { ok: false, error: "Internal Server Error during analysis." };
}
}
