import { webSearchSerper } from "./search.js";
import OpenAI from "openai";
import { DOCTOR_PROMPT } from "./doctorPrompt.js"; // تأكد من الاستيراد الصحيح

const SESSIONS = new Map();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensMessage({ sessionId, userText, history = [] }) {
const s = SESSIONS.get(sessionId) || { zip: null, pendingQuery: null };

try {
// 1. Check if input is just a ZIP code
const isZip = /^\d{5}$/.test(userText.trim());
if (isZip) {
s.zip = userText.trim();
const query = s.pendingQuery || "car parts";
s.pendingQuery = null;
SESSIONS.set(sessionId, s);
return await runLocalSearch(query, s.zip);
}

// 2. Build AI Request
const messages = [
{ role: "system", content: DOCTOR_PROMPT },
...history,
{ role: "user", content: userText }
];

const completion = await openai.chat.completions.create({
model: "gpt-4o", // استخدم gpt-4o لدعم الصور والذكاء العالي
messages,
temperature: 0.5,
});

const aiResponse = completion.choices[0].message.content;

// 3. Handle ZIP Request from AI
if (aiResponse.includes("ZIP_REQUIRED")) {
s.pendingQuery = userText;
SESSIONS.set(sessionId, s);
return {
ok: true,
text: "من فضلك زودني بالرمز البريدي (ZIP Code) لأعطيك أفضل الأسعار والمحلات القريبة منك.",
mode: "need_zip"
};
}

return { ok: true, text: aiResponse, mode: "doctor" };

} catch (error) {
console.error("Service Error:", error);
return { ok: false, error: "AI_FAILED", detail: error.message };
}
}

async function runLocalSearch(query, zip) {
const searchResult = await webSearchSerper(`${query} price nearby ${zip}`);
// تنسيق الرد ليظهر كتقرير محترف
return {
ok: true,
text: `بناءً على موقعك (${zip})، إليك أفضل الخيارات المتاحة للقطع والأسعار...`,
sources: searchResult.results
};
}
