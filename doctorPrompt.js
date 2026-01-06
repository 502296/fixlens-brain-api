// service.js - Ultra-Logic Final Version
import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";
import * as autoKB from "./lib/autoKnowledge.js";

const getAutoKnowledge = autoKB.getAutoKnowledge || null;
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64 = null, audio_base_64 = null, user_location = "Louisville, KY", history = [] } = req.body;

// 1. معالجة البحث - لن يتم مسحه أبداً كما طلبت
let searchResults = "";
if (text.includes("ورشة") || text.includes("shop") || text.includes("عنوان")) {
searchResults = await performSearch(text, user_location);
}

// 2. بناء المحتوى بذكاء خارق (Super Smart Context)
const messageContent = [
{
type: "text",
text: `STRICT MECHANICAL IDENTITY: You are a World-Class Master Mechanic.
Analyze all visual and auditory inputs as VEHICLE COMPONENTS only.
USER_INPUT: ${text}
LOCAL_SEARCH: ${searchResults}
USER_LOCATION: ${user_location}`
}
];

// 3. معالجة الصورة بدقة دكتوراه ميكانيك
if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" }
});
messageContent.push({
type: "text",
text: "VISUAL DIAGNOSIS TASK: This is a car part. Identify it and pinpoint leaks, cracks, or electrical faults."
});
}

// 4. استدعاء الموديل بأقوى Prompt عالمي
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{ role: "user", content: messageContent }
],
temperature: 0.1 // دقة جراحية
});

const reply = response.choices[0].message.content;

// منع الرد الفارغ
if (!reply) throw new Error("AI generated an empty response");

return { ok: true, reply: reply };

} catch (error) {
console.error("Critical FixLens Error:", error.message);
return { ok: false, reply: "عذراً، حدث خطأ فني في معالجة طلبك. يرجى المحاولة مرة أخرى." };
}
}
