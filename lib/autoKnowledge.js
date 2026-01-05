import fs from "fs";
import path from "path";

export function buildKnowledgeSnippets(userText = "") {
try {
const dataPath = path.join(process.cwd(), "data");
if (!fs.existsSync(dataPath)) return "";

const files = fs.readdirSync(dataPath);
let context = "";

// بحث بسيط في الملفات لتقليل التكاليف
files.forEach(file => {
const content = fs.readFileSync(path.join(dataPath, file), "utf-8");
// إذا كانت الرسالة تحتوي على كلمة مفتاحية من الملف، نرفق محتواه
if (userText.toLowerCase().includes(file.split('.')[0])) {
context += content + "\n";
}
});

return context.slice(0, 2000); // تحديد الحجم لتقليل التكلفة
} catch (e) {
return "";
}
}
