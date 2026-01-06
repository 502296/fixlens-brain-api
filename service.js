// service.js - Ultra-Logic Update
import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";
// ... بقية الاستيرادات ...

async function transcribeAudio(audioBase64) {
if (!audioBase64) return "";
// ... كود الحفظ المؤقت ...
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
// 💡 إجبار الموديل على المصطلحات الميكانيكية فقط
prompt: "Car engine diagnostic: rod knock, fan belt squeal, lifter tick, turbo lag, misfire, suspension noise."
});
return result.text;
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64, audio_base_64, user_location = "Louisville, KY" } = req.body;

const voiceText = await transcribeAudio(audio_base_64);
const combinedInput = `${text} ${voiceText}`.trim();

// ✅ بقاء الـ Search كما هو بقوته الأصلية (لا يلمس)
let searchResults = await (combinedInput.includes("ورشة") ? performSearch(combinedInput, user_location) : Promise.resolve(""));

const messageContent = [
{
type: "text",
text: `STRICT MECHANICAL CONTEXT: Every input is from a CAR.
USER_INPUT: ${combinedInput}
LOCATION: ${user_location}
SEARCH_DATA: ${searchResults}`
}
];

if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" }
});
// 💡 إجبار الموديل على رؤية الصورة كقطعة سيارة حصراً
messageContent.push({
type: "text",
text: "VISUAL DIAGNOSIS: This is a car part. Identify it and find the mechanical fault (leaks, cracks, wear)."
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
{ role: "user", content: messageContent }
],
temperature: 0.1 // 💡 دقة جراحية لمنع التخيلات
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
return { ok: false, error: "System Error. Please retry." };
}
}
