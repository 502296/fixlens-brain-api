import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* 🎙️ Voice Core: Converts audio and flags it as Primary Evidence
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
console.error("Whisper Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "Louisville, KY" // الموقع الافتراضي لك
} = req.body;

// 1. ⚡ Priority Audio Injection
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
// نضع الصوت كأولوية قصوى في بداية النص
text = `[VOICE ANALYSIS REQUEST]: ${voiceText}. Additional Context: ${text}`.trim();
}
}

// 2. 🔍 Knowledge & Local Search (Re-activated)
const internalKB = buildKnowledgeSnippets(text);

let searchResults = "";
const needsSearch = ["shop", "repair", "parts", "ورشة", "محل", "ميكانيكي", "موقع"].some(k => text.toLowerCase().includes(k));

if (needsSearch) {
// استدعاء ملف search.js والتأكد من تمرير النتائج
searchResults = await performSearch(text, user_location);
}

// 3. ✨ Elegant Style & Language Rules
const systemInstructions = `
- LANGUAGE: Answer ONLY in the language of the user's last message.
- STYLE: Clean, professional, minimal bolding.
- NO excessive symbols or stars.
- HEADERS: Translate "Immediate Analysis", "Steps", and "Pro-Tip" to user language.
`;

const finalPayload = `
${systemInstructions}
Location: ${user_location}
Input: ${text}
Local Search Results: ${searchResults || "No local data needed for this query."}
Technical Manuals: ${internalKB}
`.trim();

// 4. 🚀 Execute with GPT-4o
const messages = [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history.slice(-2), // لضمان السرعة وتجنب البطء
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
max_tokens: 800
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Core Error:", error);
throw error;
}
}
