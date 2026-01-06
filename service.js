import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

// ✅ إصلاح مشكلة استيراد autoKnowledge لمنع SyntaxError
import * as autoKB from "./lib/autoKnowledge.js";
const getAutoKnowledge = autoKB.getAutoKnowledge || null;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* ✅ دالة تحويل الصوت: يجب أن تكون هنا في الأعلى
* لكي لا يعطي السيرفر خطأ "not defined"
*/
async function transcribeAudio(audioBase64) {
if (!audioBase64 || audioBase64.length < 50) return null;
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Mechanical sound: engine knocking, squealing, ticking, or car issue description."
});
return result.text;
} catch (err) {
console.error("Whisper Error:", err.message);
return null;
} finally {
if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
}

/**
* ✅ الوظيفة الرئيسية لمعالجة طلبات FixLens
*/
export async function handleFixLensRequest(req) {
try {
// استلام البيانات مع قيم افتراضية لمنع ReferenceError
const {
text = "",
image_base64 = null,
audio_base_64 = null,
history = [],
user_location = "Louisville, KY"
} = req.body;

// 1. معالجة الصوت والبحث في وقت واحد لسرعة الاستجابة
const [voiceText, searchResults] = await Promise.all([
transcribeAudio(audio_base_64),
(text.includes("ورشة") || text.includes("عنوان") || text.includes("shop"))
? performSearch(text, user_location)
: Promise.resolve("")
]);

const fullQuery = `${voiceText || ""} ${text}`.trim();

// 2. جلب المعرفة المحلية إذا كانت الدالة موجودة
const kbData = getAutoKnowledge ? getAutoKnowledge(fullQuery) : "";

// 3. بناء الرسالة الموجهة لـ GPT-4o
const messageContent = [
{
type: "text",
text: `LOCATION: ${user_location}\nSEARCH: ${searchResults}\nKB: ${kbData}\nINPUT: ${fullQuery}`
}
];

// إضافة الصورة إذا وجدت
if (image_base64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "low" }
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{
role: "system",
content: `${buildDoctorSystemPrompt()} \n- Respond in the user's language. \n- Use professional mechanical headings in their language.`
},
...history.slice(-2),
{ role: "user", content: messageContent }
],
temperature: 0.2
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error.message);
return { ok: false, error: "Server encountered an error. Please try again." };
}
}
