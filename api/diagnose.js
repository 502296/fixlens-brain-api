// api/diagnose.js
// FixLens Brain – Diagnose endpoint
// يستخدم autoKnowledge.js + GPT ليعطي تشخيص ذكي يدعم كل اللغات

import OpenAI from "openai";
import { buildIssueSummaryForLLM } from "../lib/autoKnowledge.js";

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
res.setHeader(
"Access-Control-Allow-Headers",
"Content-Type, Authorization",
);
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

const {
// النص الذي يكتبه المستخدم بأي لغة
description,
message,
text,
userText,
transcript,

// معلومات إضافية عن السيارة (اختيارية لكن مفيدة للـ GPT)
vehicleMake,
vehicleModel,
vehicleYear,
engine,
transmission,
mileage,

// موقع/منطقة المستخدم (يفيد بنصائح مثل الملح/الشتاء/الحرارة)
region,
country,

// أكواد OBD-II إن وجدت
troubleCodes,

// وسائط إضافية (وصف الصوت، ملاحظات عن الصورة... الخ)
audioNotes,
imageNotes,

// وضع FixLens (text / sound / camera)
mode,

// لغة مفضلة (اختياري) – لكن نعتمد أساساً على كشف اللغة من النص
preferredLanguage,
} = body;

// 🔥 1) نجمع كل الأسماء المحتملة للنص في متغيّر واحد موحّد
let mergedDescription =
description ??
message ??
text ??
userText ??
transcript ??
imageNotes ??
audioNotes ??
"";

if (typeof mergedDescription !== "string") {
mergedDescription = String(mergedDescription || "");
}
mergedDescription = mergedDescription.trim();

if (!mergedDescription || mergedDescription.length < 2) {
return res.status(400).json({
error: "Missing or invalid 'description' in request body.",
});
}

// 2) استخدم قاعدة المعرفة auto_common_issues.json لمطابقة الأعراض
const knowledgeSummary = buildIssueSummaryForLLM(mergedDescription, {
topN: 8,
minScore: 1,
});

// 3) نبني JSON واضح نرسله للـ GPT
const llmInput = {
user_description: mergedDescription,
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

// 4) System Prompt – كشف لغة + استخدام قاعدة المعرفة + أمان
const systemPrompt = `
You are **FixLens Brain**, a world-class, multi-language automotive diagnostic assistant.

CORE RULES (VERY IMPORTANT):
1. **Language Detection**
- First, detect the user's language from "user_description".
- Respond in the SAME language you detect.
- If the user mixes languages (e.g., Arabic + English), choose the dominant language but you may keep technical terms in English if natural.
- You must support ALL human languages (Arabic, English, Spanish, French, Chinese, etc.), similar to ChatGPT.

2. **Knowledge Base Usage**
- You receive a field "knowledge_base_matches": these are pre-matched issues from FixLens internal database (auto_common_issues.json).
- Use these matches as a **strong hint** for likely causes, recommended checks, and safety warnings.
- Do NOT contradict clear safety warnings from the knowledge base.
- If matches are weak or not relevant, say that these are only possible directions, not confirmed diagnoses.

3. **Safety & Disclaimer**
- You are NOT a replacement for a real mechanic or emergency service.
- If there is any serious safety risk (brakes failure, steering loss, fuel leak, fire risk, high-voltage fault, engine severe knock, overheating with steam, etc.),
clearly warn the user to STOP driving and seek professional help immediately.
- Always include a short, clear disclaimer at the end.

4. **Structure of Your Answer**
Answer in a friendly, clear, and practical way. Use short sections. A good structure (adapt in any language):

- **Quick Summary**: 2-3 sentences about what might be happening, in user language.
- **Most Likely Causes** (1–4 bullet points):
- Combine your reasoning + knowledge_base_matches.likely_causes / possible_causes.
- **What You Can Check Now** (step-by-step, safe actions the user can do):
- Use knowledge_base_matches.recommended_checks when relevant.
- **Safety / When to Stop Driving**:
- Use knowledge_base_matches.safety_warning plus your own reasoning.
- **Next Professional Step**:
- What to tell a mechanic, what tests to ask for, or which specialist to see.
- **Short Disclaimer**:
- Example in English: "This is an AI assistant, not a substitute for an in-person inspection. If you feel unsafe, stop driving and seek professional help."
- Translate this idea to the user's language.

5. **Tone**
- Calm, respectful, and reassuring.
- No jokes about safety. Be friendly but serious when risk is high.

You will receive all input as a JSON object from FixLens. Read it carefully and base your reasoning on it.
If "knowledge_base_matches" is empty, still give your best general guidance, but clearly say that this is a general direction, not a confirmed diagnosis.
`.trim();

// 5) طلب من GPT (مع الحفاظ على تعدد اللغات)
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
// نرسل JSON كامل حتى يكون عنده كل شيء
content: JSON.stringify(llmInput, null, 2),
},
],
});

const answer =
completion.choices?.[0]?.message?.content?.trim() ||
"Sorry, I could not generate a response.";

// 6) نرجع الرد للتطبيق
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
