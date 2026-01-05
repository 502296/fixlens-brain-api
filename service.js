import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
* المعالج الرئيسي لطلبات FixLens
* صُمم ليكون "عقل" الميكانيكي المحترف
*/
export async function handleFixLensRequest(req) {
try {
let { text, locale, image_base64, audio_base64 } = req.body;

// 1. الكشف الذكي عن اللغة (حتى لو لم يرسلها التطبيق)
if (!locale) {
const isArabic = /[\u0600-\u06FF]/.test(text || "");
locale = isArabic ? "ar" : "en";
}

// 2. جلب المعرفة المحلية (RAG) لتقليل الهلوسة البرمجية
// يبحث في ملفات الـ JSON عن أي معلومات مطابقة لشكوى المستخدم
const kb = buildKnowledgeSnippets(text || "");
// صياغة نص المستخدم مع البيانات الداخلية ليكون الذكاء الاصطناعي "مطلعاً"
const enrichedUserText = text
? `${text}\n\n[CONTEXT DATA]:\n${kb}`
: `Analyze the attached media. [CONTEXT DATA]:\n${kb}`;

// 3. توجيه الطلب بناءً على نوع المرفقات
if (image_base64) {
return await analyzeWithVision(enrichedUserText, locale, image_base64);
}
// ملاحظة: إذا كنت تستخدم Whisper للصوت، يمكنك إضافة معالجة audio_base64 هنا

return await analyzeWithText(enrichedUserText, locale);

} catch (error) {
console.error("CRITICAL_ERROR in handleFixLensRequest:", error);
throw error;
}
}

/**
* تحليل النصوص والبيانات (Text-only)
*/
async function analyzeWithText(userText, locale) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{ role: "user", content: userText },
],
temperature: 0.7, // توازن بين الإبداع والدقة التقنية
});

return {
ok: true,
reply: response.choices[0].message.content,
engine: "gpt-4o-text"
};
}

/**
* تحليل الصور (Vision) - عين الميكانيكي
*/
async function analyzeWithVision(userText, locale, base64Image) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{
role: "user",
content: [
{ type: "text", text: userText },
{
type: "image_url",
image_url: {
url: `data:image/jpeg;base64,${base64Image}`,
detail: "high" // لتحليل أدق للتسريبات والأسلاك
},
},
],
},
],
max_tokens: 1000,
});

return {
ok: true,
reply: response.choices[0].message.content,
engine: "gpt-4o-vision"
};
}
