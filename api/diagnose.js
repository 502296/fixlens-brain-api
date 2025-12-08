// api/diagnose.js
// FixLens Brain – Diagnose endpoint
// يستخدم autoKnowledge.js + GPT ليعطي تشخيص ذكي يدعم كل اللغات

import OpenAI from "openai";
import { buildIssueSummaryForLLM } from "../lib/autoKnowledge.js";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// تقدر تغيّر الموديل من متغيّر البيئة FIXLENS_MODEL
// مثال في Vercel: FIXLENS_MODEL=gpt-4.1
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

try {
const body = req.body || {};

// 🔴 هنا السر: نقبل كل الأسماء المحتملة من التطبيق أو من أي عميل آخر
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

// باقي الحقول الاختيارية كما هي (ممكن تستخدمها لاحقاً في واجهة متقدمة)
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
} = body;

// 1) استخدم قاعدة المعرفة auto_common_issues.json لمطابقة الأعراض
let knowledgeSummary;
try {
knowledgeSummary = buildIssueSummaryForLLM(description, {
topN: 8,
minScore: 1,
});
} catch (e) {
console.error("[diagnose] autoKnowledge error:", e);
// لو صار خطأ في الـ JSON لا نكسر الـ API كله
knowledgeSummary = { matches: [], error: "autoKnowledge_failed" };
}

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
knowledge_base_matches: knowledgeSummary.matches || [],

// hint فقط إن وُجد، لكن القاعدة الذهبية: اللغة من user_description
language_hint: preferredLanguage || null,
};

// 3) System Prompt – كشف لغة قوي + التزام كامل بنفس لغة وصف المستخدم
const systemPrompt = `
You are **FixLens Brain**, a world-class, multi-language automotive diagnostic assistant.

GLOBAL LANGUAGE RULE (SUPER IMPORTANT):
- You MUST detect the language **only from** the field "user_description" in the JSON you receive.
- Then you must answer **entirely in that same language**.
- Do NOT switch to Arabic or any other language unless user_description itself is mainly written in that language.
- If user_description is in English, your whole answer must be English.
- If user_description is in Arabic, your whole answer must be Arabic.
- If user_description is in Spanish, your whole answer must be Spanish.
- Do not randomly mix languages. Only mix when the user clearly mixes them and it feels natural (for example, keeping technical terms in English).

CORE RULES:

1. Language Detection
- Read "user_description" from the JSON.
- Detect the dominant language of that text.
- Respond in the SAME dominant language.
- If the user mixes languages (e.g., Arabic + English), choose the dominant language but you may keep some technical words in English if natural.
- You must support ALL human languages (Arabic, English, Spanish, French, Chinese, etc.), similar to ChatGPT.

2. Knowledge Base Usage
- You receive "knowledge_base_matches": these are pre-matched issues from FixLens internal database (auto_common_issues.json).
- Use these matches as a **strong hint** for likely causes, recommended checks, and safety warnings.
- Do NOT contradict clear safety warnings from the knowledge base.
- If matches are weak or not relevant, say clearly that these are only possible directions, not confirmed diagnoses.

3. Safety & Disclaimer
- You are NOT a replacement for a real mechanic or emergency service.
- If there is any serious safety risk (brakes failure, steering loss, fuel leak, fire risk, high-voltage fault, engine severe knock, overheating with steam, etc.),
clearly warn the user to STOP driving and seek professional help immediately.
- Always include a short, clear disclaimer at the end, in the same language as the answer.

4. Structure of Your Answer
Answer in a friendly, clear, and practical way. Use short sections. A good structure (adapt in any language):

- **Quick Summary**: 2–3 sentences summarizing what might be happening.
- **Most Likely Causes** (1–4 bullet points):
- Combine your reasoning + knowledge_base_matches.likely_causes / possible_causes.
- **What You Can Check Now**:
- Step-by-step, safe actions the user can do.
- Use knowledge_base_matches.recommended_checks when relevant.
- **Safety / When to Stop Driving**:
- Use knowledge_base_matches.safety_warning plus your own reasoning.
- **Next Professional Step**:
- What to tell a mechanic, what tests to ask for, or which specialist to see.
- **Short Disclaimer**:
- Example idea in English: "This is an AI assistant, not a substitute for an in-person inspection. If you feel unsafe, stop driving and seek professional help."
- Translate the meaning of this disclaimer to the user's language.

5. Tone
- Calm, respectful, and reassuring.
- No jokes about safety. Be friendly but serious when risk is high.

You will receive all input as a JSON object from FixLens. Read it carefully and base your reasoning on it.
If "knowledge_base_matches" is empty or weak, still give your best general guidance, but clearly say that this is a general direction, not a confirmed diagnosis.
`.trim();

// 4) طلب من GPT (مع الحفاظ على تعدد اللغات والهيكل الواضح)
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

// 5) نرجّع الرد للتطبيق
return res.status(200).json({
ok: true,
model: MODEL,
message: answer,
// نرسل أيضاً الماتشات لو حاب تستخدمها في الواجهة لاحقاً (اختياري)
knowledge: knowledgeSummary,
});
} catch (err) {
console.error("[diagnose] Error:", err);
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
