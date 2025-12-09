// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const apiKey = process.env.OPENAI_API_KEY || "";

const openai = new OpenAI({
apiKey,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ code: 405, message: "Method not allowed" });
}

try {
const body =
typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

// نقبل كل الأسماء القديمة والجديدة
const message =
body.message ||
body.text ||
body.user_message ||
body.prompt ||
"";

const languageHint = body.language || "auto";
const mode = body.mode || "text";

if (!message || !message.trim()) {
return res
.status(400)
.json({ code: 400, message: "Message required." });
}

if (!apiKey) {
// مفتاح OpenAI مفقود → رسالة واضحة بدل 500 غامض
return res.status(500).json({
code: 500,
message:
"OPENAI_API_KEY is not configured on the server. Please add it in Vercel Environment Variables.",
});
}

// نحاول نقرأ autoKnowledge لكن ما نسمح له يكسر الـ API
let autoKnowledgeText = null;
try {
autoKnowledgeText = findRelevantIssues(message);
} catch (err) {
console.error("autoKnowledge error:", err);
autoKnowledgeText = null;
}

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for cars, home appliances, and general mechanical issues.

Rules:
- ALWAYS reply in the SAME LANGUAGE as the user's message.
- Be friendly, clear, and step-by-step.
- Ask 2–3 smart follow-up questions if needed.
- If the user describes a car problem, think like a professional mechanic.
- If it's a different type of problem (home, appliance, etc.), think like the right pro.
- Be honest about uncertainty and give safety warnings when needed.

If extra internal knowledge is provided, use it but do NOT mention "database" or "autoKnowledge" in your answer.
`;

const messages = [
{ role: "system", content: systemPrompt },
autoKnowledgeText
? { role: "system", content: autoKnowledgeText }
: null,
{ role: "user", content: message },
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

// ================== Supabase Logging (اختياري وآمن) ==================
try {
// نستورد الموديل ديناميكياً حتى لو فيه خطأ ما يكسر الملف كله
const supaModule = await import("../lib/supabaseClient.js");
const logFixLensEvent = supaModule.logFixLensEvent;

if (typeof logFixLensEvent === "function") {
try {
await logFixLensEvent({
source: "mobile-app",
mode,
userMessage: message,
aiReply: reply,
meta: {
languageHint,
model: "gpt-4.1-mini",
},
});
} catch (logErr) {
console.error("Supabase log error:", logErr);
}
} else {
console.warn(
"logFixLensEvent is not a function. Supabase logging skipped."
);
}
} catch (moduleErr) {
// أي خطأ في استيراد supabaseClient.js لن يكسر الـ API
console.error("Supabase module load error, logging skipped:", moduleErr);
}
// =====================================================================

return res.status(200).json({
code: 200,
message: "OK",
reply,
});
} catch (err) {
console.error("FixLens Brain diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
