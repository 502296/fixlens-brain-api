import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
if (!audioBase64) return null;
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
// تم تحسين الـ prompt ليفهم أن الصوت قد يكون محركاً فقط وليس كلاماً
prompt: "Mechanical sound diagnostic: engine knocking, squealing, ticking. If it's speech, transcribe it. If it's noise, describe the noise."
});
return result.text;
} catch (err) {
console.error("Whisper Error:", err);
return "Unrecognizable mechanical noise";
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
const {
text = "",
image_base_64 = null,
audio_base_64 = null,
history = [],
user_location = "Louisville, KY"
} = req.body;

// 1. معالجة الصوت أولاً وبشكل إلزامي قبل البحث
let audioTranscript = "";
if (audio_base_64) {
audioTranscript = await transcribeAudio(audio_base_64);
}

const fullQuery = `${text} ${audioTranscript}`.trim();

// 2. تشغيل البحث (Search) بناءً على النص المدمج (صوت + نص)
let searchResults = "";
const keywords = ["ورشة", "عنوان", "shop", "repair", "parts", "location", "قريب"];
if (keywords.some(k => fullQuery.toLowerCase().includes(k))) {
// ننتظر نتيجة البحث لضمان ظهورها في الرد
searchResults = await performSearch(fullQuery, user_location);
}

// 3. بناء المحتوى (إصلاح الصور والعناوين)
const userContent = [
{
type: "text",
text: `
USER_LOCATION: ${user_location}
SEARCH_RESULTS_FROM_GOOGLE: ${searchResults || "No local data found"}
AUDIO_ANALYSIS: ${audioTranscript || "No audio provided"}
USER_TEXT: ${text}
`.trim()
}
];

if (image_base_64) {
userContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}` }
});
}

// 4. استدعاء الموديل مع تقليل التاريخ (History) لتسريع الرد وحل مشكلة التعليق
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()}
- ALWAYS respond in the user's language.
- Translate all headers (e.g., **التقييم الفوري**, **خطوات العمل**).
- If SEARCH_RESULTS_FROM_GOOGLE is present, you MUST provide real addresses.`
},
...history.slice(-2), // تقليل التاريخ لرسالتين فقط لتسريع الأداء
{ role: "user", content: userContent }
],
temperature: 0.1 // دقة قصوى
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("Backend Error:", error);
return { ok: false, error: "System busy. Please try again." };
}
}
