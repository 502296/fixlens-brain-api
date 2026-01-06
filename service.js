import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* 🎙️ High-Fidelity Voice Transcription
*/
async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.mp3`);
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

/**
* 🚀 Super Smart Request Handler (The Brain)
*/
export async function handleFixLensRequest(req) {
try {
let {
text = "",
image_base64,
audio_base64,
history = [],
user_location = "Global"
} = req.body;

// 1. Audio Analysis (Priority Injection)
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}
}

// 2. Intelligent Global Search (Triggers for parts, shops, or locations)
let searchResults = "";
const searchKeywords = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "سكراب", "محل", "اين"];
if (searchKeywords.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// 3. Knowledge Base & Context Construction
const technicalData = buildKnowledgeSnippets(text);
const finalPayload = `
[SYSTEM_RULES]: Clean UI. Respond in user language.
[REGION]: ${user_location}
[USER_INPUT]: ${text}
[TECHNICAL_MANUALS]: ${technicalData}
[LOCAL_MARKET_DATA]: ${searchResults || "Global search active..."}
`.trim();

// 4. GPT-4o Master Execution
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2), // لضمان السرعة الفائقة
{
role: "user",
content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload
}
],
temperature: 0.3, // دقة ميكانيكية عالية
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error);
throw error;
}
}
