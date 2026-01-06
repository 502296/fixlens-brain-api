import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* 🎙️ Global Voice Processing (Whisper)
*/
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
console.error("Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* 🧠 Global Expert Logic Handler
*/
export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "Global" // يستقبل الموقع من GPS الهاتف (مثل: Louisville, KY أو Dubai, UAE)
} = req.body;

// 1. Audio Injection: Priority focus on mechanical sounds
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. Global Smart Search: Triggers based on intent
let searchResults = "";
const searchIntents = ["shop", "parts", "junk", "tire", "battery", "cheap", "where", "ورشة", "سكراب", "إطارات", "محل"];
const needsSearch = searchIntents.some(k => text.toLowerCase().includes(k));

if (needsSearch) {
// البحث يتم بناءً على إحداثيات أو اسم المدينة المرسل من التطبيق
searchResults = await performSearch(text, user_location);
}

// 3. Technical Payload Construction
const finalPayload = `
STRICT UI RULES: Translate all headers to user language. Use clean bold text. NO excessive stars.
USER REGION: ${user_location}
INPUT ANALYSIS: ${text}
TECHNICAL CONTEXT: ${buildKnowledgeSnippets(text)}
LOCAL MARKET DATA: ${searchResults || "Searching global database..."}
`.trim();

// 4. Expert AI Execution
const messages = [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history.slice(-3),
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
temperature: 0.3, // للحفاظ على الدقة الميكانيكية
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Service Error:", error);
throw error;
}
}
