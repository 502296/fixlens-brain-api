import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة معالجة الصوت: تم تصحيح امتداد الملف ليكون مدعوماً
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`); // امتداد m4a لضمان التوافق
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
// ✅ تصحيح اسم المتغير: تم تغيير audio_base_64 إلى audio_base64
let {
text = "",
image_base64,
audio_base64,
history = [],
user_location = "Global"
} = req.body;

// معالجة الصوت في حالة توفره
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}

// تفعيل البحث العالمي (Louisville, London, etc.)
let searchResults = "";
const intents = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "محل"];
if (intents.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

const finalPayload = `
REGION: ${user_location}
USER_INPUT: ${text}
LOCAL_DATA: ${searchResults || "Search active..."}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload }
],
temperature: 0.3,
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
console.error("FixLens Core Error:", error);
throw error;
}
}
