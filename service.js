import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";
// ✅ استيراد ملفات المعرفة إذا كانت موجودة
import { getAutoKnowledge } from "./lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة لجلب البيانات التقنية من مجلد /data بناءً على نوع المشكلة
function fetchLocalData(query) {
const dataDir = path.join(process.cwd(), 'data');
const files = ["engine.json", "brakes.json", "transmission.json", "electrical.json"];
let combinedData = "";

try {
if (query.includes("محرك") || query.includes("engine")) {
combinedData += fs.readFileSync(path.join(dataDir, "engine.json"), "utf-8");
}
if (query.includes("فرامل") || query.includes("brakes")) {
combinedData += fs.readFileSync(path.join(dataDir, "brakes.json"), "utf-8");
}
// يمكنك إضافة شروط لبقية الملفات هنا
} catch (e) { console.log("Data file not found, skipping..."); }
return combinedData;
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64, audio_base_64, history = [], user_location = "Louisville, KY" } = req.body;

// 1. تشغيل البحث والمعالجة المتوازية (للسرعة القصوى)
const [voiceText, searchResults] = await Promise.all([
transcribeAudio(audio_base_64),
(text.includes("ورشة") || text.includes("عنوان")) ? performSearch(text, user_location) : Promise.resolve("")
]);

const fullQuery = `${text} ${voiceText || ""}`;

// 2. ✅ جلب البيانات من ملفات /data و autoKnowledge
const localSpecs = fetchLocalData(fullQuery);
const autoKnowledgeBase = getAutoKnowledge ? getAutoKnowledge(fullQuery) : "";

// 3. بناء الـ Payload لـ GPT-4o (دمج كل المصادر)
const userContent = [{
type: "text",
text: `
[LOCAL_DATA]: ${localSpecs}
[KNOWLEDGE_BASE]: ${autoKnowledgeBase}
[SEARCH_RESULTS]: ${searchResults}
[USER_QUERY]: ${fullQuery}
[LOCATION]: ${user_location}
`.trim()
}];

if (image_base_64) {
userContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "low" }
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: `${buildDoctorSystemPrompt()} Respond in user language. Use headers in their language.` },
...history.slice(-1),
{ role: "user", content: userContent }
],
temperature: 0.1
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("FixLens Global Brain Error:", error);
return { ok: false, error: "حدث خطأ في النظام، يرجى المحاولة ثانية." };
}
}
