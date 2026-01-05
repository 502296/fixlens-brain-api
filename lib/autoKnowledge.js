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
const jsonData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
const contentString = JSON.stringify(jsonData).toLowerCase();

// بحث ذكي عن المدن، الورش، أو الأعطال
if (query.includes(file.replace(".json", "")) || keywordsInContent(query, contentString)) {
matchedKnowledge += `\n[Internal Ref: ${file}]: ${JSON.stringify(jsonData)}\n`;
}
}
}
return matchedKnowledge || "No local match. Using global expert knowledge.";
} catch (err) {
return "";
}
}

function keywordsInContent(query, content) {
// إضافة كلمات مفتاحية عالمية (مدن، أنظمة، ماركات)
const globalKeywords = ["usa", "iraq", "uk", "louisville", "baghdad", "engine", "transmission", "brake", "sensor", "price", "workshop", "ورشة", "سعر", "تصليح"];
return globalKeywords.some(kw => query.includes(kw) && content.includes(kw));
}
