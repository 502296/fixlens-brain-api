// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { logFixLensEvent } from "../lib/supabaseClient.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// دالة بسيطة لمحاولة تخمين اللغة من النص
function guessLanguage(text) {
if (!text || !text.trim()) return null;
const t = text.trim();

// Arabic
if (/[\u0600-\u06FF]/.test(t)) return "ar";
// Cyrillic → Russian تقريباً
if (/[\u0400-\u04FF]/.test(t)) return "ru";
// Greek
if (/[\u0370-\u03FF]/.test(t)) return "el";
// CJK
if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

const lower = t.toLowerCase();

if (/[ñáéíóúü]|hola\b|gracias\b|buenos\s+d[ií]as/.test(lower)) return "es";
if (/[àâçéèêëîïôùûüÿœ]|bonjour\b|merci\b/.test(lower)) return "fr";
if (/[äöüß]|hallo\b|danke\b/.test(lower)) return "de";

// ASCII فقط → غالباً إنجليزي
if (/^[\x00-\x7F]+$/.test(t)) return "en";

return null;
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "Method not allowed" });
}

const startTime = Date.now();

try {
const body =
typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const message =
body.message || body.text || body.user_message || body.prompt || "";

const languageHint = body.language || "auto";
const mode = body.mode || "text";

if (!message || !message.trim()) {
return res
.status(400)
.json({ code: 400, message: "Message required." });
}

const autoKnowledge = findRelevantIssues(message);

let targetLanguage = null;
if (languageHint && languageHint !== "auto") {
targetLanguage = languageHint;
} else {
targetLanguage = guessLanguage(message) || "en";
}

const languageInstruction =
targetLanguage === "en"
? "Reply in natural English, unless the text is clearly in another language."
: `Reply strictly in this language: ${targetLanguage}.`;

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for cars, home appliances, and general mechanical issues.

Language rule:
- ${languageInstruction}
- NEVER switch to another language unless the user clearly switches.
- If there's any Arabic, answer fully in Arabic. If Spanish, answer in Spanish, etc.

General rules:
- Be friendly, clear, and step-by-step.
- Start with a short **Quick Summary**.
- Then list **Most Likely Causes** as bullet points.
- Then **What You Can Check Now**.
- Then **Safety / When to Stop Driving or Using the device**.
- Then **Next Professional Step**.
- Ask 2–3 smart follow-up questions if needed.
- If the user describes a car problem, think like a professional mechanic.
- If it's a different type of problem (home, appliance, etc.), think like the right pro.
- Be honest about uncertainty and give safety warnings when needed.

If extra internal knowledge is provided, use it but do NOT mention "database" or "autoKnowledge" in your answer.
`;

const messages = [
{ role: "system", content: systemPrompt },
autoKnowledge
? {
role: "system",
content: autoKnowledge,
}
: null,
{ role: "user", content: message },
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";
const latencyMs = Date.now() - startTime;

// Log إلى Supabase (بدون ما يكسر لو فشل)
logFixLensEvent({
source: "mobile-app",
endpoint: "/api/diagnose",
mode,
inputType: "text",
userLang: targetLanguage,
userMessage: message,
aiReply: reply,
status: "success",
latencyMs,
meta: {
languageHint,
targetLanguage,
model: "gpt-4.1-mini",
},
}).catch(() => {});

return res.status(200).json({
code: 200,
message: "OK",
reply,
});
} catch (err) {
console.error("FixLens Brain diagnose error:", err);

const latencyMs = Date.now() - startTime;
// نحفظ لوج خطأ (اختياري)
logFixLensEvent({
source: "mobile-app",
endpoint: "/api/diagnose",
mode: "text",
inputType: "text",
status: "error",
errorMessage: err?.message || String(err),
latencyMs,
meta: {
model: "gpt-4.1-mini",
},
}).catch(() => {});

return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
