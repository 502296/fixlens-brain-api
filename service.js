import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
console.error("Whisper Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
// تم تصحيح اسم المتغير هنا ليتوافق مع السجلات
let { text = "", image_base64, audio_base64, history = [], user_location = "Global" } = req.body;

if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `[AUDITORY EVIDENCE]: "${voiceText}". ${text}`.trim();
}

let searchResults = "";
const searchTerms = ["shop", "parts", "junk", "tire", "battery", "where", "cheap", "ورشة", "محل"];
if (searchTerms.some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

const finalPayload = `
[GLOBAL_PROTOCOL]: Professional Mechanic Analysis. No Stars. Use user language.
[REGION]: ${user_location}
[TECHNICAL_INPUT]: ${text}
[LOCAL_MARKET_DATA]: ${searchResults || "Search active..."}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base_64}` } }
] : finalPayload }
],
temperature: 0.3,
max_tokens: 1000
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
console.error("FixLens Global Brain Error:", error);
throw error;
}
}
