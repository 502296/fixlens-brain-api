export async function handleFixLensRequest(req) {
try {
let { text, locale, image_base64 } = req.body;

// تحسين: إذا لم يرسل التطبيق locale، نتحقق من النص
if (!locale) {
const isArabic = /[\u0600-\u06FF]/.test(text);
locale = isArabic ? "ar" : "en";
}

const kb = buildKnowledgeSnippets(text);
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
