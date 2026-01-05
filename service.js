import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ تصدير الدالة بشكل صحيح لحل خطأ SyntaxError
export async function handleFixLensRequest(req) {
try {
const { text, locale, image_base64 } = req.body;
// جلب البيانات المحلية لتقليل استخدام الـ Tokens والمصاريف
const kb = buildKnowledgeSnippets(text);
const userText = `${text}\n\n[Internal Data]:\n${kb}`;

// التحقق مما إذا كان هناك صورة
if (image_base64) {
return await analyzeWithVision(userText, locale, image_base64);
}

return await analyzeWithText(userText, locale);
} catch (error) {
console.error("Error in handleFixLensRequest:", error);
throw error;
}
}

async function analyzeWithText(userText, locale) {
const response = await client.chat.completions.create({
model: "gpt-4o", // ✅ استخدام الموديل الأفضل
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{ role: "user", content: userText },
],
});
return { ok: true, reply: response.choices[0].message.content };
}

async function analyzeWithVision(userText, locale, base64Image) {
const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt(locale) },
{
role: "user",
content: [
{ type: "text", text: userText },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
],
},
],
});
return { ok: true, reply: response.choices[0].message.content };
}
