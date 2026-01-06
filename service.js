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

// 1. معالجة وحقن الصوت في المقدمة (Priority Injection)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
if (voiceText) {
// نضع النص الصوتي في البداية ليعرف الموديل أنه أهم جزء
text = `CRITICAL SOUND ANALYSIS: "${voiceText}". ${text}`.trim();
}
}

// 2. تحسين السرعة عبر تقليل الـ History (Speed Optimization)
const shortHistory = history.slice(-2);

// 3. تعليمات الأناقة واللغة (No Spanish / No Stars Policy)
const strictStyleGuide = `
STRICT SYSTEM RULES:
- LANGUAGE: Respond ONLY in the language used by the user in the prompt. Do not switch to Spanish unless the user speaks Spanish.
- VISUAL STYLE: Use a clean, elegant layout.
- NO excessive stars (***) or heavy bolding.
- Use simple dashes (-) for lists.
- HEADERS: Translate headers like "Immediate Analysis" to the user's current language.
`;

const finalPayload = `
${strictStyleGuide}
Context: ${user_location}
Input to Analyze: ${text}
Technical Data: ${buildKnowledgeSnippets(text)}
Local Services: ${await performSearch(text, user_location)}
`.trim();

// 4. استدعاء الموديل (التحكم في الـ Tokens لسرعة الاستجابة)
const modelParams = {
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
...shortHistory,
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base64}` } }
] : finalPayload },
],
temperature: 0.3,
max_tokens: 700, // سقف منخفض لضمان السرعة ومنع الثقل
};

const response = await client.chat.completions.create(modelParams);
return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}
