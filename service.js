import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* Super Smart Voice Injection
* Logic: Transcribes audio then injects it as a primary user observation.
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
console.error("Audio Engine Error:", err);
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
user_location = "USA"
} = req.body;

// Smart Audio Injection: Prioritizing the sound of the engine/issue
if (audio_base64) {
const voiceNoteText = await transcribeAudio(audio_base64);
if (voiceNoteText) {
text = `[Auditory Observation]: ${voiceNoteText}. ${text}`.trim();
}
}

// Knowledge Retrieval
const internalKB = buildKnowledgeSnippets(text);

// Global & Local Search Compatibility
let searchResults = "";
const needsLocalHelp = ["shop", "repair", "parts", "mechanic", "ورشة", "محل"].some(k => text.toLowerCase().includes(k));

if (needsLocalHelp) {
searchResults = await performSearch(text, user_location);
}

const finalPayload = `
User Region: ${user_location}
Input Analysis: ${text}
Technical Database: ${internalKB}
Local Availability: ${searchResults}
`.trim();

// Call GPT-4o with Neutral "Assessment" terminology for Apple compliance
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
temperature: 0.4, // Precise facts
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
