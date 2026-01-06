import fs from "fs";
import path from "path";

export function buildKnowledgeSnippets(userText = "") {
try {
const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) return "Global Database Online.";

const files = fs.readdirSync(dataDir);
let matchedKnowledge = "";
const query = userText.toLowerCase();

for (const file of files) {
if (file.endsWith(".json")) {
const filePath = path.join(dataDir, file);
const fileNameNoExt = file.replace(".json", "").toLowerCase();
// إذا ذكر المستخدم اسم الملف (مثل اسم شاحنة أو عطل) أو كلمات مفتاحية داخل الملف
if (query.includes(fileNameNoExt)) {
const jsonData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
matchedKnowledge += `\n[DATA REF: ${file}]: ${JSON.stringify(jsonData)}\n`;
}
}
}
// إذا لم يجد شيئاً في الـ data، يكتفي بالرد العالمي
return matchedKnowledge || "Standard professional protocols apply.";
} catch (err) {
return "";
}
}
