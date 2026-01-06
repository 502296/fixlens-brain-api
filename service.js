import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `audio_${Date.now()}.mp3`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) { return null; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
let { text = "", image_base64, audio_base64, history = [], user_location = "Louisville, KY" } = req.body;

// 1. معالجة الصوت كدليل فني
let voiceTranscript = "";
if (audio_base64) {
voiceTranscript = await transcribeAudio(audio_base64);
if (voiceTranscript) text = `[Technical Audio Note]: ${voiceTranscript}. ${text}`.trim();
}

// 2. تفعيل البحث المحلي بدقة (Optimized Search)
let searchResults = "";
const searchTerms = ["shop", "repair", "parts", "ورشة", "محل", "ميكانيكي"];
if (searchTerms.some(k => text.toLowerCase().includes(k))) {
// نرسل فقط الكلمات المفتاحية للبحث لضمان الدقة
const searchQuery = voiceTranscript || text;
searchResults = await performSearch(searchQuery.substring(0, 50), user_location);
}

// 3. البرومبت العميق (Expert Mechanic Logic)
const masterInstructions = `
- ROLE: Senior Master Mechanic with 30+ years of global experience.
- TONE: Highly technical, precise, and authoritative.
- FORMAT: Clean bold headers in the user's language. No Stars.
- CONTENT: Provide specific mechanical causes (sensors, pressures, electrical values).
`;

const finalPayload = `
${masterInstructions}
Location Context: ${user_location}
User Query/Sound: ${text}
Manual Snippets: ${buildKnowledgeSnippets(text)}
Local Shop Data: ${searchResults}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt("auto") },
...history.slice(-3),
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload },
],
temperature: 0.4,
max_tokens: 1000 // رفعنا عدد التوكنز ليعطي شرحاً فنياً أعمق
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) { throw error; }
}
