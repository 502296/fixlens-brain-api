import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة محسنة لقراءة ملفات الـ JSON (Data) لزيادة الذكاء الميكانيكي
function getLocalTechnicalData(issueType) {
try {
const filePath = path.join(process.cwd(), 'data', `${issueType}.json`);
if (fs.existsSync(filePath)) {
return fs.readFileSync(filePath, 'utf-8');
}
} catch (e) { return ""; }
return "";
}

async function transcribeAudio(audioBase64) {
if (!audioBase64) return null;
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Mechanical sound: engine knocking, squealing, ticking, grinding noises." // لإجبار الموديل على فهم الصوت
});
return result.text;
} catch (err) { return null; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base64, audio_base_64, user_location = "Louisville, KY", history = [] } = req.body;

// 1. معالجة الصوت
let fullInputText = text;
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) fullInputText = `[AUDIO]: ${voiceText}. ${text}`;
}

// 2. جلب بيانات ميكانيكية من ملفات الـ JSON (مثال: محرك)
const engineData = fullInputText.includes("محرك") || fullInputText.includes("engine") ? getLocalTechnicalData("engine") : "";

// 3. تفعيل البحث عن ورش حقيقية (SerpApi)
let liveSearch = "";
if (fullInputText.includes("ورشة") || fullInputText.includes("عنوان") || fullInputText.includes("shop")) {
liveSearch = await performSearch(fullInputText, user_location);
}

// 4. بناء الـ Prompt لضمان الرد بنفس اللغة واستخدام البيانات
const systemInstruction = `${buildDoctorSystemPrompt()}
- Respond ALWAYS in the user's language.
- Use the LOCAL_DATA and SEARCH_RESULTS provided below to give REAL addresses and technical specs.
- Be direct. Use bullet points.`;

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: systemInstruction },
...history.slice(-3),
{ role: "user", content: `
DATA_FILES: ${engineData}
SEARCH_RESULTS: ${liveSearch}
USER_INPUT: ${fullInputText}
LOCATION: ${user_location}`
}
],
temperature: 0.1 // دقة عالية جداً
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
console.error("Critical Error:", error);
throw error;
}
}
