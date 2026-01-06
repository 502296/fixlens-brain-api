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
} catch (err) {
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

// 1. عزل الصوت وحقنه كأولوية قصوى (Priority Injection)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
// نضع الصوت في المقدمة ليكون هو المحرك الأساسي للتحليل
text = `PRIMARY AUDIO EVIDENCE: "${voiceText}". ${text}`.trim();
}
}

// 2. تقليل حجم التاريخ لتسريع الشبكة (Optimization)
const shortHistory = history.slice(-3);

// 3. تعليمات الأناقة واللغة (No Stars Policy)
const styleGuide = `
STRICT UI RULES:
- Use ONLY single dashes (-) for lists.
- Use plain bold text for headers.
- NO excessive stars or triple bold (***).
- Headers must be in the USER'S LANGUAGE.
- Format: Header Name: content.
`;

const finalPayload = `
${styleGuide}
Location Context: ${user_location}
Input Analysis: ${text}
Manual Data: ${buildKnowledgeSnippets(text)}
Local Shops: ${await performSearch(text, user_location)}
`.trim();

if (image_base64) {
return await analyzeWithVision(finalPayload, locale, image_base64, shortHistory);
}
return await analyzeWithText(finalPayload, locale, shortHistory);

} catch (error) {
console.error("FixLens Error:", error);
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
temperature: 0.3,
max_tokens: 800, // تسريع وقت الاستجابة
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
max_tokens: 800,
});
return { ok: true, reply: response.choices[0].message.content };
}
