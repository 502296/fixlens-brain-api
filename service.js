import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* Super Smart Voice Engine
* Injects audio as a high-priority technical observation.
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
console.error("Audio Engine Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* Main FixLens Request Handler
*/
export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "USA"
} = req.body;

// 1. Professional Voice Injection
// جعلنا الصوت يظهر كـ "ملاحظة فنية مسموعة" ليعطيه النظام اهتماماً أكبر من النص العادي
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `[AUDITORY EVIDENCE]: User described or recorded this symptom: "${voiceText}". Analyze this sound/description with priority. ${text}`.trim();
}
}

// 2. Knowledge & Local Search
const internalKB = buildKnowledgeSnippets(text);

let searchResults = "";
const searchKeywords = ["shop", "repair", "parts", "ورشة", "محل", "ميكانيكي"];
if (searchKeywords.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

// 3. Smart Formatting Instructions
// هنا نقوم بحقن تعليمات التنسيق واللغة داخل الـ Payload لضمان أناقة العناوين وترجمتها
const smartInstructions = `
IMPORTANT FORMATTING:
- Translate all headers to the user's language (e.g., if the user speaks Arabic, headers must be in Arabic).
- Style: Use a clean single dash '-' or simple bold text for headers. Avoid excessive stars '***'.
- Header Names: "Immediate Analysis", "Recommended Action Steps", "Pro-Tip".
`;

const finalPayload = `
${smartInstructions}
Region: ${user_location}
Input Analysis: ${text}
Technical Context: ${internalKB}
Local Availability: ${searchResults}
`.trim();

// 4. Send to GPT-4o
if (image_base64) {
return await analyzeWithVision(finalPayload, locale, image_base64, history);
}
return await analyzeWithText(finalPayload, locale, history);

} catch (error) {
console.error("FixLens Service Exception:", error);
throw error;
}
}

async function analyzeWithText(payload, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{ role: "user", content: payload },
],
temperature: 0.4,
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(payload, locale, base64Image, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{
role: "user",
content: [
{ type: "text", text: payload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}
