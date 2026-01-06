import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة تحويل الصوت (Whisper)
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
console.error("Whisper Engine Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

// ✅ تصدير الوظيفة الرئيسية (تم إصلاح الـ Export)
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

// 1. حقن الصوت كدليل فني أساسي
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. البحث العالمي الذكي (يستخدم الموقع المرسل من الموبايل)
let searchResults = "";
const shoppingTerms = ["shop", "parts", "junk", "tire", "battery", "cheap", "where", "ورشة", "سكراب", "محل"];
if (shoppingTerms.some(k => text.toLowerCase().includes(k))) {
// البحث يعمل الآن في أي مدينة يرسلها التطبيق (Louisville, London, etc.)
searchResults = await performSearch(text, user_location);
}

// 3. بناء السياق الميكانيكي الفائق
const finalPayload = `
INSTRUCTION: You are a Global Master Mechanic. Use the Search Results to give specific shop names.
USER_REGION: ${user_location}
TECHNICAL_INPUT: ${text}
KNOWLEDGE_BASE: ${buildKnowledgeSnippets(text)}
LOCAL_MARKET_DATA: ${searchResults || "No local data provided."}
`.trim();

// 4. استدعاء الموديل العالمي GPT-4o
const messages = [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history.slice(-2),
{
role: "user",
content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload
}
];

const response = await client.chat.completions.create({
model: "gpt-4o",
messages,
temperature: 0.3,
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}
