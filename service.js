import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة الصوت: تم ضبط الامتداد m4a لضمان التوافق مع OpenAI
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
console.error("Whisper Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* 🚀 handleFixLensRequest: العقل المدبر العالمي
*/
export async function handleFixLensRequest(req) {
try {
// توحيد المسميات لإنهاء أخطاء السجلات (ReferenceError)
let {
text = "",
image_base64,
audio_base64, // تأكد أن Flutter يرسل هذا الاسم بالضبط
history = [],
user_location = "Global"
} = req.body;

// معالجة الصوت إذا وجد
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) text = `[TECHNICAL SOUND DATA]: "${voiceText}". ${text}`.trim();
}

// تفعيل البحث العالمي المحترف (Louisville, London, Paris, etc.)
let searchResults = "";
const searchIntents = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "سكراب"];
if (searchIntents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// بناء السياق النهائي (إجبار الموديل على رؤية النتائج)
const finalPayload = `
[SYSTEM]: Master Mechanic Mode. Use Search results for specific shops.
[REGION]: ${user_location}
[INPUT]: ${text}
[LOCAL_DATA]: ${searchResults || "Search enabled..."}
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
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload
}
],
temperature: 0.3,
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error);
throw error;
}
}
