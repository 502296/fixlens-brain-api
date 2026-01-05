import fs from "fs";
import path from "path";

export function buildKnowledgeSnippets(userText = "") {
try {
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) return "";

const files = fs.readdirSync(dataDir);
let matchedKnowledge = "";
const query = userText.toLowerCase();

for (const file of files) {
if (file.endsWith(".json")) {
const filePath = path.join(dataDir, file);
const rawData = fs.readFileSync(filePath, "utf-8");
const jsonData = JSON.parse(rawData);

// تحويل محتوى الـ JSON لنص ليقوم الذكاء الاصطناعي بفحصه
const contentString = JSON.stringify(jsonData).toLowerCase();

// إذا كانت رسالة المستخدم تحتوي على اسم النظام (مثل engine) أو كلمات داخل الملف
if (query.includes(file.replace(".json", "")) || keywordsInContent(query, contentString)) {
matchedKnowledge += `\n[Reference: ${file}]: ${JSON.stringify(jsonData)}\n`;
}
}
}

// نرسل أول 1500 حرف فقط لتقليل التكلفة (Context window optimization)
return matchedKnowledge.substring(0, 1500);
} catch (err) {
console.error("Knowledge Error:", err);
return "";
}
}

function keywordsInContent(query, content) {
const commonKeywords = ["check", "error", "leak", "sensor", "قير", "حرارة", "تهريب"];
return commonKeywords.some(kw => query.includes(kw) && content.includes(kw));
}
