import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* Super Smart Voice Processing
* Injects transcribed text directly into the main intelligence flow.
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
console.error("Audio Analysis Error:", err);
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

// Direct Voice Injection
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `[Voice Observation]: ${voiceText}. ${text}`.trim();
}

const internalKB = buildKnowledgeSnippets(text);

// Intelligent Search Trigger
let searchResults = "";
const searchTerms = ["shop", "repair", "parts", "mechanic", "ورشة", "محل", "ميكانيكي"];
if (searchTerms.some(term => text.toLowerCase().includes(term))) {
searchResults = await performSearch(text, user_location);
}

// Professional Input Formatting (Avoiding "Diagnostic" keyword)
const processedInput = `
Region: ${user_location}
Input: ${text}
Technical Data: ${internalKB}
Local Options: ${searchResults}
`.trim();

if (image_base64) {
return await analyzeWithVision(processedInput, locale, image_base64, history);
}
return await analyzeWithText(processedInput, locale, history);

} catch (error) {
console.error("FixLens Core Exception:", error);
throw error;
}
}

async function analyzeWithText(input, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{ role: "user", content: input },
],
temperature: 0.4,
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(input, locale, base64Image, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{
role: "user",
content: [
{ type: "text", text: input },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}
