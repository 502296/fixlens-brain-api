import fs from "fs";
import path from "path";

/**
* وظيفة هذه الدالة هي قراءة ملفات البيانات والبحث عن الكلمات المفتاحية
* التي وردت في رسالة المستخدم لجلب الحلول المناسبة فقط.
*/
export function buildKnowledgeSnippets(userText = "") {
try {
const dataDir = path.join(process.cwd(), "data");
// التأكد من وجود المجلد
if (!fs.existsSync(dataDir)) return "";

const files = fs.readdirSync(dataDir);
let matchedContent = "";
const lowerText = userText.toLowerCase();

for (const file of files) {
// نقرأ فقط ملفات النص أو الكود
if (file.endsWith(".txt") || file.endsWith(".json") || file.endsWith(".md")) {
const filePath = path.join(dataDir, file);
const content = fs.readFileSync(filePath, "utf-8");

// استخراج الكلمات المفتاحية (مثلاً: اسم القطعة أو كود العطل)
// إذا وجدنا الكلمة في النص، نأخذ الجزء المتعلق بها
if (lowerText.includes(file.split('.')[0].toLowerCase()) || containsKeyword(lowerText, content)) {
matchedContent += `\n--- From File: ${file} ---\n${content.substring(0, 1000)}\n`;
}
}
}

return matchedContent.trim();
} catch (err) {
console.error("Error reading knowledge base:", err);
return "";
}
}

// دالة مساعدة للبحث عن كلمات تقنية بسيطة
function containsKeyword(text, content) {
// يمكنك إضافة كلمات مفتاحية خاصة بالشاحنات هنا
const keywords = ["gear", "derate", "battery", "sensor", "engine", "قير", "بطارية", "محرك"];
return keywords.some(kw => text.includes(kw) && content.toLowerCase().includes(kw));
}
