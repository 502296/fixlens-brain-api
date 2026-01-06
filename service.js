import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ وظيفة ذكية لتحويل الصوت مع دعم "أصوات الميكانيكا"
async function transcribeAudio(audioBase64) {
if (!audioBase64 || audioBase64.length < 10) return null;
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Mechanical diagnostic sound: clicking, rattling, engine knocking, squealing."
});
return result.text;
} catch (err) {
console.error("Whisper Fail:", err.message);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
// ✅ توحيد المسميات لضمان عدم حدوث ReferenceError
const {
text = "",
image_base64 = null,
audio_base_64 = null,
history = [],
user_location = "Louisville, KY"
} = req.body;

// 1. معالجة الصوت والبحث بشكل متزامن لسرعة الاستجابة (حل مشكلة التعليق)
const [voiceText, searchResults] = await Promise.all([
transcribeAudio(audio_base_64),
(text.includes("ورشة") || text.includes("shop") || text.includes("عنوان"))
? performSearch(text, user_location)
: Promise.resolve("")
]);

const finalUserText = voiceText ? `[AUDIO]: ${voiceText}. [TEXT]: ${text}` : text;

// 2. بناء محتوى الرسالة لـ GPT-4o ليدعم الصور
const messageContent = [
{
type: "text",
text: `LOCATION: ${user_location}\nSEARCH_DATA: ${searchResults}\nINPUT: ${finalUserText}`
}
];

if (image_base64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}` }
});
}

// 3. الاستجابة مع إجبار اللغة وتغيير العناوين تلقائياً
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()}
- Respond in the user's language.
- ALL headers like (Immediate Assessment, Action Steps) MUST be in the same language as the response.
- Use SEARCH_DATA to provide REAL addresses and phone numbers.`
},
...history.slice(-2), // تقليل الـ history يحل مشكلة ثقل الشبكة
{ role: "user", content: messageContent }
],
temperature: 0.1
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("Critical FixLens Error:", error.message);
return { ok: false, error: "حدث خطأ فني، يرجى إعادة المحاولة." };
}
}
