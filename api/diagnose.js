// api/diagnose.js

import OpenAI from "openai";
import autoKnowledge, { findMatchingIssues } from "../lib/autoKnowledge.js";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// نحمل ملف auto_common_issues.json من جذر المشروع
const commonIssuesPath = path.join(process.cwd(), "auto_common_issues.json");
const commonIssues = JSON.parse(fs.readFileSync(commonIssuesPath, "utf8"));

/**
* دالة بسيطة لاكتشاف اللغة من نص المستخدم.
* لا تعتمد على عشوائية النموذج، إنما على الحروف والكلمات الشائعة.
* ترجع اسم اللغة بالإنجليزي: "English", "Arabic", "Spanish", ...
*/
function detectLanguageFromText(text) {
if (!text || typeof text !== "string") return "English";
const t = text.trim();

// أحرف عربية
if (/[ء-ي]/.test(t)) return "Arabic";

// أحرف صينية / يابانية / كورية
if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return "East Asian";

// أحرف كيريلية (روسية مثلاً)
if (/[\u0400-\u04FF]/.test(t)) return "Russian";

// علامات لهجات إسبانية
if (/[áéíóúñ¿¡]/i.test(t) || /\b(hola|coche|ruido|acelerar|frenar)\b/i.test(t)) {
return "Spanish";
}

// كلمات فرنسية شائعة
if (/\b(bonjour|voiture|frein|accélération)\b/i.test(t)) {
return "French";
}

// كلمات ألمانية شائعة
if (/\b(hallo|auto|bremse|gas|motor)\b/i.test(t)) {
return "German";
}

// كلمات تركية شائعة
if (/\b(merhaba|araba|fren|gaz)\b/i.test(t)) {
return "Turkish";
}

// لو النص قصير جدًا مثل "hi" أو "hello" أو "هلو" → اعتبره إنجليزي افتراضي
if (t.length <= 5) {
return "English";
}

// الافتراضي
return "English";
}

// System prompt أساسي
function buildSystemPrompt() {
return `
You are **FixLens Auto**, a super-intelligent global automotive diagnostic assistant.

GOALS:
- Help drivers around the world understand what might be happening with their vehicle.
- ALWAYS keep the driver safe.
- Use the knowledge provided (autoKnowledge + commonIssues + matchedIssues) as context.

LANGUAGE RULES (VERY IMPORTANT):
1) There is a field called "preferredLanguage" in extraContext.
2) If preferredLanguage is provided, ALWAYS answer ONLY in that language.
3) If preferredLanguage is not provided, detect the language from the user's latest message and answer in that language.
4) Never randomly switch languages. Stay consistent.
5) Examples:
- If preferredLanguage = "English" → answer pure English.
- If preferredLanguage = "Arabic" → answer pure Modern Standard Arabic.
- If preferredLanguage = "Spanish" → answer pure Spanish.
- If "East Asian" → use the dominant script in the user's message (Chinese/Japanese/Korean).

BEHAVIOR:
- If the message is just a greeting (e.g., "hello", "هلو", "hola", "مرحبا", etc.),
DO NOT generate a diagnosis.
Instead:
1) Greet the driver nicely in their language.
2) Ask them to describe the problem: noises, lights, leaks, smells, when it happens, etc.

- If the message does NOT contain any clear vehicle symptom:
1) Explain that the description is unclear.
2) Ask the driver to describe the car issue in more detail.
3) Give 2–3 example questions they can answer (when, where, what sound, any warning lights).

- If there **is** a clear vehicle symptom, follow this structure EXACTLY:

1) Short title:
- One line summary of the main issue (in the same language).

2) Most likely causes:
- 2–4 bullet points.
- Use simple, clear language.
- If there is risk of catalytic converter damage or safety risk, mention it.

3) What to check now:
- 3–6 bullet points: practical checks, scan codes, what the mechanic should inspect.
- Prioritize simple checks first, then advanced ones.

4) Safety note:
- Short, practical safety advice.
- If the issue is severe (flashing check engine, brake problems, steering, overheating, etc.),
clearly say that the driver should avoid driving and get professional help quickly.

STYLE:
- Be friendly, calm, and professional.
- No extra introductions. Start directly with point 1), 2), 3), 4).
- Keep each answer compact and easy to read on a phone.
- You can reference general systems (ignition, fuel, cooling, suspension, brakes),
but avoid guessing exact part numbers or prices.
`;
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
let { message, mode = "text", extraContext = {} } = req.body || {};

if (!message || typeof message !== "string" || !message.trim()) {
return res.status(400).json({ error: "Message is required" });
}

const userMessage = message.trim();

// نتأكد أن extraContext كائن
if (typeof extraContext !== "object" || extraContext === null) {
extraContext = {};
}

// لو ما عندنا preferredLanguage من التطبيق، نكشفه من النص
if (!extraContext.preferredLanguage) {
extraContext.preferredLanguage = detectLanguageFromText(userMessage);
}

const preferredLanguage = extraContext.preferredLanguage;

// نستخدم autoKnowledge لمطابقة الأعراض (اختياري لكنه يقوي المنطق)
let matchedIssues = [];
try {
matchedIssues = findMatchingIssues(userMessage, 5);
} catch (e) {
console.error("findMatchingIssues error:", e);
}

const systemPrompt = buildSystemPrompt();

const knowledgeBlob = {
autoKnowledge,
commonIssues,
matchedIssues,
mode,
extraContext,
};

const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.3,
max_tokens: 900,
messages: [
{
role: "system",
content: systemPrompt,
},
{
role: "system",
content:
"BACKGROUND KNOWLEDGE (do NOT show this to the user):\n" +
JSON.stringify(knowledgeBlob).slice(0, 12000),
},
{
role: "system",
content: `User preferred language: ${preferredLanguage}. You MUST answer ONLY in this language and never switch.`,
},
{
role: "user",
content: userMessage,
},
],
});

const reply =
completion.choices?.[0]?.message?.content ||
"Sorry, something went wrong while generating the diagnosis.";

return res.status(200).json({
ok: true,
source: "diagnose",
mode,
message: userMessage,
answer: reply,
preferredLanguage,
matchedIssues,
});
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
ok: false,
error: "Internal error while generating diagnosis.",
});
}
}
