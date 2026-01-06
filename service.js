import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";
import * as autoKB from "./lib/autoKnowledge.js";

const getAutoKnowledge = autoKB.getAutoKnowledge || null;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
if (!audioBase64 || audioBase64.length < 50) return "";
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
// 💡 إجبار Whisper على قاموس المصطلحات الميكانيكية لقتل "مطحنة الثوم"
prompt: "Automotive engine diagnostic: rod knock, fan belt squeal, lifter tick, turbo lag, misfire."
});
return result.text;
} catch (err) { return ""; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64 = null, audio_base_64 = null, history = [], user_location = "Louisville, KY" } = req.body;

const voiceText = await transcribeAudio(audio_base_64);
const combinedInput = `${text} ${voiceText}`.trim();

// ✅ بقاء الـ Search كما هو بقوته الأصلية
let searchResults = "";
const searchKeywords = ["ورشة", "عنوان", "موقع", "shop", "near", "address"];
if (searchKeywords.some(kw => combinedInput.toLowerCase().includes(kw))) {
searchResults = await performSearch(combinedInput, user_location);
}

const kbData = getAutoKnowledge ? getAutoKnowledge(combinedInput) : "";

// 💡 إضافة "توجيه بصري ميكانيكي" إلزامي مع الصورة
const messageContent = [
{
type: "text",
text: `STRICT CONTEXT: This is a professional mechanical inspection in ${user_location}.\nINPUT: ${combinedInput}\nSEARCH_DATA: ${searchResults}\nKNOWLEDGE: ${kbData}`
}
];

if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" }
});
// 💡 إجبار الموديل على رؤية الصورة كقطعة سيارة
messageContent.push({
type: "text",
text: "VISUAL TASK: Identify the specific CAR PART in this image and diagnose any damage, leaks, or wear."
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-4),
{ role: "user", content: messageContent }
],
temperature: 0.1 // 💡 دقة جراحية لمنع التخيلات
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error.message);
return { ok: false, error: "System Error. Restarting diagnostic module..." };
}
}
