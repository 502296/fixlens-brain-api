import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ تحسين Whisper لسماع أصوات المحرك بدقة عالية
async function transcribeAudio(audioBase64) {
if (!audioBase64) return null;
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Mechanical diagnostic: knocking, squealing, grinding, ticking, engine noise."
});
return result.text;
} catch (err) {
console.error("Audio Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
const {
text = "",
image_base64 = null,
audio_base_64 = null,
history = [],
user_location = "Louisville, KY"
} = req.body;

// 1. معالجة الصوت ودمجه مع النص
let combinedText = text;
if (audio_base_64) {
const voiceNote = await transcribeAudio(audio_base_64);
if (voiceNote) {
combinedText = `[Audio Transcript]: ${voiceNote}. ${text}`;
}
}

// 2. تفعيل البحث (موجود مسبقاً كما طلبت)
let searchResults = "";
const needsSearch = ["ورشة", "عنوان", "shop", "parts", "location", "قريب"].some(k => combinedText.toLowerCase().includes(k));
if (needsSearch) {
searchResults = await performSearch(combinedText, user_location);
}

// 3. بناء الرسالة للموديل (إصلاح الصور واللغة)
const userContent = [];
// إضافة النص والبيانات المحسنة
userContent.push({
type: "text",
text: `LOCATION: ${user_location}\nSEARCH_DATA: ${searchResults}\nUSER_INPUT: ${combinedText}`
});

// ✅ إصلاح قراءة الصور: تمرير الصورة كـ URL Base64
if (image_base64) {
userContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}` }
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()}
- IMPORTANT: Translate ALL headings (like Immediate Assessment, Action Steps) to the user's language.
- If the user speaks Arabic, headers must be in Arabic (e.g., **التقييم الفوري**).
- Analyze the attached image or audio description with high technical precision.`
},
...history.slice(-4),
{ role: "user", content: userContent }
],
temperature: 0.3
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Error:", error);
return { ok: false, error: "حدث خطأ أثناء التحليل، يرجى المحاولة مرة أخرى." };
}
}
