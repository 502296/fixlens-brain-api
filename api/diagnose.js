// api/diagnose.js
// FixLens Brain – Diagnose endpoint
// يستخدم autoKnowledge.js + GPT ليعطي تشخيص ذكي يدعم كل اللغات

import OpenAI from "openai";
import { buildIssueSummaryForLLM } from "../lib/autoKnowledge.js";
import { saveLog, logError, saveMemory } from "../lib/logs.js";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// لو حاب تغيّر الموديل من .env:
const MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";

/**
* Helper: allow CORS for the mobile app / web.
*/
function setCorsHeaders(res) {
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
setCorsHeaders(res);

// Preflight
if (req.method === "OPTIONS") {
return res.status(200).end();
}

if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed. Use POST." });
}

const startedAt = Date.now();

try {
const body = req.body || {};

// 🔴 هنا السر: نقبل كل الأسماء المحتملة من التطبيق
let description =
body.description ||
body.text ||
body.message ||
body.prompt ||
body.query ||
null;

// لو جاية Array (نادرًا) نخليها نص واحد
if (Array.isArray(description)) {
description = description.join(" ");
}

if (description != null && typeof description !== "string") {
description = String(description);
}

if (!description || !description.trim()) {
return res.status(400).json({
error:
"Missing or invalid description. Please send a text description of the problem in the request body.",
receivedKeys: Object.keys(body),
});
}

// باقي الحقول الاختيارية كما هي
const {
vehicleMake,
vehicleModel,
vehicleYear,
engine,
transmission,
mileage,
region,
country,
troubleCodes,
audioNotes,
imageNotes,
mode,
preferredLanguage,
userId, // لو أرسلناه من التطبيق لاحقاً
} = body;

// 1) استخدم قاعدة المعرفة auto_common_issues.json لمطابقة الأعراض
const knowledgeSummary = buildIssueSummaryForLLM(description, {
topN: 8,
minScore: 1,
});

// 2) نبني JSON واضح نرسله للـ GPT
const llmInput = {
user_description: description,
mode: mode || "text",
user_region: region || country || null,

vehicle: {
make: vehicleMake || null,
model: vehicleModel || null,
year: vehicleYear || null,
engine: engine || null,
transmission: transmission || null,
mileage: mileage || null,
},

diagnostics: {
trouble_codes: troubleCodes || [],
audio_notes: audioNotes || null,
image_notes: imageNotes || null,
},

// أهم شيء: الماتشات من قاعدة المعرفة
knowledge_base_matches: knowledgeSummary.matches,

// hint فقط إن وجد، لكن GPT لازم يكتشف اللغة بنفسه
language_hint: preferredLanguage || null,
};

// 3) System Prompt – كشف لغة + رد بنفس اللغة + أمان
const systemPrompt = `
You are **FixLens Brain**, a world-class, multi-language automotive diagnostic assistant.

[نفس النص السابق تماماً هنا بدون تغيير...]
`.trim();

// 4) طلب من GPT (مع الحفاظ على تعدد اللغات)
const completion = await client.chat.completions.create({
model: MODEL,
temperature: 0.4,
messages: [
{
role: "system",
content: systemPrompt,
},
{
role: "user",
content: JSON.stringify(llmInput, null, 2),
},
],
});

const answer =
completion.choices?.[0]?.message?.content?.trim() ||
"Sorry, I could not generate a response.";

const latencyMs = Date.now() - startedAt;

// استنتاج اللغة من الرد بشكل بسيط جداً (نقدر نطوره لاحقاً)
let detectedLang = null;
try {
if (answer.match(/[\u0600-\u06FF]/)) {
detectedLang = "ar";
} else if (answer.match(/[áéíóúñ¿¡]/i)) {
detectedLang = "es";
} else if (answer.match(/[äöüß]/i)) {
detectedLang = "de";
} else {
detectedLang = "en";
}
} catch (_) {
detectedLang = null;
}

// 5) حفظ Log في Supabase
await saveLog({
endpoint: "diagnose",
mode: mode || "text",
inputType: "free_text",
userLang: detectedLang,
userDescription: description,
aiResponse: answer,
model: MODEL,
status: "success",
latencyMs,
meta: {
region: region || country || null,
troubleCodes: troubleCodes || [],
knowledge: knowledgeSummary,
},
});

// 6) حفظ ذاكرة بسيطة (اختياري الآن، ممكن نطوره لاحقاً)
await saveMemory({
userId: userId || null,
key: "recent_case",
content: `Case: ${description}\n\nAnswer:\n${answer}`,
importance: 1,
});

// 7) نرجع الرد للتطبيق
return res.status(200).json({
ok: true,
model: MODEL,
message: answer,
knowledge: knowledgeSummary,
});
} catch (err) {
console.error("[diagnose] Error:", err);

// نحفظ الخطأ في جدول خاص
await logError({
endpoint: "diagnose",
error: err,
payload: req.body || null,
});

return res.status(500).json({
ok: false,
error: "Internal error in FixLens diagnose endpoint.",
details:
process.env.NODE_ENV === "development"
? String(err?.message || err)
: undefined,
});
}
}
