import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensRequest(req) {
try {
// Added 'history' to the destructuring to receive past messages from your local storage
let { text = "", locale, image_base64, audio_base64, history = [] } = req.body;

// 1. Voice Transcription (Whisper)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) text = `${text} [User Voice Note]: ${voiceText}`.trim();
}

// 2. Smart Language & Context Detection
// We let GPT-4o handle the dialect, we just pass the hint
if (!locale || locale === "auto") {
locale = /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
}

// 3. RAG (Internal Database)
const kb = buildKnowledgeSnippets(text);
const finalUserPrompt = `
[CONSULTATION DETAILS]:
User Input: ${text}
[INTERNAL KNOWLEDGE BASE]:
${kb}

Please generate the Professional Diagnostic Report.`;

// 4. Execution (Vision or Text) with History Integration
if (image_base64) {
return await analyzeWithVision(finalUserPrompt, locale, image_base64, history);
}
return await analyzeWithText(finalUserPrompt, locale, history);

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}

async function analyzeWithText(userText, locale, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale, history) },
...history, // This inserts the local history from the mobile device
{ role: "user", content: userText },
],
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(userText, locale, base64Image, history) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale, history) },
...history,
{
role: "user",
content: [
{ type: "text", text: userText },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}

// TranscribeAudio remains the same as your original code...
