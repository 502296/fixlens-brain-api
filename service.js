import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة معالجة الصوت (يجب أن تظل هنا لتكون مرئية للجميع)
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
console.error("Audio Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
let { text = "", image_base64, audio_base64, history = [], user_location = "Global" } = req.body;

// 1. حقن الصوت كدليل فني محوري
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. البحث العالمي المحترف (Louisville, London, etc.)
let searchResults = "";
const intents = ["shop", "parts", "junk", "tire", "battery", "where", "ورشة", "سكراب", "إطارات", "محل"];
if (intents.some(k => text.toLowerCase().includes(k))) {
// نرسل استعلام البحث بناءً على موقع المستخدم الفعلي
searchResults = await performSearch(text, user_location);
}

// 3. بناء السياق النهائي (إجبار الموديل على رؤية نتائج البحث)
const finalPayload = `
STRICT UI: Use clean bold text. NO Stars. Respond ONLY in user language.
USER_REGION: ${user_location}
MASTER_INPUT: ${text}
TECHNICAL_DATABASE: ${buildKnowledgeSnippets(text)}
LOCAL_MARKET_DATA: ${searchResults || "Consulting global network..."}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt("auto") },
...history.slice(-2),
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload },
],
temperature: 0.3,
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}
