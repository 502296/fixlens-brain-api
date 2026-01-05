import OpenAI from "openai";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js"; // تأكد من وجود هذا السطر

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensRequest(req) {
try {
let { text, locale, image_base64 } = req.body;

// إصلاح اللغة تلقائياً
if (!locale) {
const isArabic = /[\u0600-\u06FF]/.test(text);
locale = isArabic ? "ar" : "en";
}

const kb = buildKnowledgeSnippets(text); // الآن ستعمل هذه الدالة
const userText = `${text}\n\n[Internal Data]:\n${kb}`;

if (image_base64) {
return await analyzeWithVision(userText, locale, image_base64);
}

return await analyzeWithText(userText, locale);
} catch (error) {
console.error("Error in handleFixLensRequest:", error);
throw error;
}
}

// ... باقي الدوال (analyzeWithText, analyzeWithVision) كما هي
