import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* Helper: Transcribe Audio using OpenAI Whisper
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
console.error("Transcription Error:", err);
return null;
} finally {
if (fs.existsSync(tempPath)) {
fs.unlinkSync(tempPath);
}
}
}

/**
* Core Request Handler for FixLens
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

// 1. Audio Processing: Convert voice to text if present
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
text = `${text} [Voice Note]: ${voiceText}`.trim();
}
}

// 2. Data Retrieval: Local RAG + Intelligent Web Search
const internalKB = buildKnowledgeSnippets(text);

let searchResults = "";
const searchKeywords = ["shop", "workshop", "parts", "repair", "محل", "ورشة", "ميكانيكي"];
const needsSearch = searchKeywords.some(kw => text.toLowerCase().includes(kw));

if (needsSearch) {
searchResults = await performSearch(text, user_location);
}

// 3. Final Context Construction (No messy headers)
const finalContext = `
User Location: ${user_location}
Current Query: ${text}

Technical Context:
${internalKB}

Local Search Results:
${searchResults}
`.trim();

// 4. Execution: Select Vision or Text model based on input
if (image_base64) {
return await analyzeWithVision(finalContext, locale, image_base64, history);
}
return await analyzeWithText(finalContext, locale, history);

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}

/**
* Text-only Diagnosis
*/
async function analyzeWithText(payload, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...history,
{ role: "user", content: payload },
],
temperature: 0.5, // Lower temperature for more consistent diagnostic facts
});
return { ok: true, reply: response.choices[0].message.content };
}

/**
* Image + Text Diagnosis
*/
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
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } },
],
},
],
max_tokens: 1000,
});
return { ok: true, reply: response.choices[0].message.content };
}
