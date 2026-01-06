import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ 1. دالة معالجة الصوت (مكتوبة بشكل صحيح لتجنب ReferenceError)
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
console.error("Whisper Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

// ✅ 2. تصدير الوظيفة الرئيسية (تم إصلاح الـ Export ليعمل السيرفر)
export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "Global"
} = req.body;

// معالجة الصوت وحقنه كدليل فني
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `PRIMARY AUDIO EVIDENCE: "${voiceText}". ${text}`.trim();
}
}

// تفعيل البحث العالمي بناءً على الموقع المرسل (لندن، باريس، لويفيل)
let searchResults = "";
const intents = ["shop", "parts", "junk", "tire", "battery", "where", "ورشة", "سكراب", "إطارات", "محل"];
if (intents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// بناء السياق النهائي (إجبار الموديل على رؤية النتائج)
const finalPayload = `
STRICT UI RULES: No Stars (**). Use clean bold text. Translate headers.
REGION: ${user_location}
INPUT: ${text}
TECHNICAL_DB: ${buildKnowledgeSnippets(text)}
LOCAL_DATA: ${searchResults || "Searching worldwide network..."}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
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
console.error("FixLens Global Service Error:", error);
throw error;
}
}
