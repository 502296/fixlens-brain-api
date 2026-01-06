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
// ✅ تعديل الـ Prompt لإجبار Whisper على التركيز على ميكانيكا السيارات
prompt: "Car engine sounds, knocking, diagnostic description, automotive repair."
});
return result.text;
} catch (err) {
return "";
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

export async function handleFixLensRequest(req) {
try {
const {
text = "",
image_base_64 = null,
audio_base_64 = null,
history = [],
user_location = "Louisville, KY"
} = req.body;

// 1. تحويل الصوت أولاً لنعرف ماذا يريد المستخدم
const voiceText = await transcribeAudio(audio_base_64);

// 2. دمج النص المكتوب مع النص المسموع للبحث الشامل
const combinedInput = `${text} ${voiceText}`.trim();

// 3. تفعيل البحث إذا وجد طلب لورشة في (النص المكتوب أو المسموع)
let searchResults = "";
const searchKeywords = ["ورشة", "عنوان", "موقع", "قريب", "shop", "near", "location", "address"];
const needsSearch = searchKeywords.some(kw => combinedInput.toLowerCase().includes(kw));

if (needsSearch) {
console.log("🔍 Triggering Local Search for:", user_location);
searchResults = await performSearch(combinedInput, user_location);
}

const kbData = getAutoKnowledge ? getAutoKnowledge(combinedInput) : "";

// 4. بناء محتوى الرسالة لـ GPT-4o (Vision + Text)
const messageContent = [
{
type: "text",
text: `USER_LOCATION: ${user_location}\nLOCAL_SEARCH_RESULTS: ${searchResults}\nTECHNICAL_KB: ${kbData}\nUSER_INPUT: ${combinedInput}`
}
];

if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: {
url: `data:image/jpeg;base64,${image_base_64}`,
detail: "high" // ✅ رفع الدقة لتحليل أعطال المحرك بدقة
}
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()}
- IMPORTANT: If images are provided, prioritize visual evidence of leaks, cracks, or wear.
- If SEARCH_RESULTS are provided, you MUST list the top 3 workshops with their addresses and distances.
- Current Location is ${user_location}.`
},
...history.slice(-4), // زيادة السياق قليلاً
{ role: "user", content: messageContent }
],
temperature: 0.1 // تقليل العشوائية ليكون التشخيص دقيقاً
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Error:", error.message);
return { ok: false, error: "Server error." };
}
}
