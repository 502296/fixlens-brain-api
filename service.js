import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة الصوت: تم ضبط الامتداد m4a لضمان التوافق مع OpenAI Whisper
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

export async function handleFixLensRequest(req) {
try {
// ✅ تصحيح المتغيرات لضمان عدم حدوث ReferenceError
let {
text = "",
image_base64,
audio_base64,
history = [],
user_location = "Global"
} = req.body;

// 1. معالجة الصوت وحقنه في النص كدليل فني
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. تفعيل البحث العالمي (في أي مدينة بالعالم يرسلها الموبايل)
let searchResults = "";
const shoppingIntents = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "سكراب", "إطارات"];
if (shoppingIntents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// 3. بناء Payload احترافي (إجبار الموديل على رؤية النتائج)
const finalPayload = `
STRICT UI: Clean bold headers. NO STARS. Respond in user language.
REGION: ${user_location}
INPUT: ${text}
LOCAL_MARKET_DATA: ${searchResults || "No local data needed for this query."}
KNOWLEDGE_BASE: ${buildKnowledgeSnippets(text)}
`.trim();

// 4. استدعاء الموديل بذكاء Master Mechanic
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
