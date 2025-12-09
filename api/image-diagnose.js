// api/image-diagnose.js
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

const imageBase64 = body.imageBase64 || body.image || "";
const note = body.note || "";
const languageHint = body.language || "auto";
const mode = "image";

if (!imageBase64 || !imageBase64.trim()) {
return res.status(400).json({
code: 400,
message: "imageBase64 is required.",
});
}

if (!apiKey) {
return res.status(500).json({
code: 500,
message:
"OPENAI_API_KEY is not configured on the server. Please add it in Vercel Environment Variables.",
});
}

let autoKnowledgeText = null;
try {
// نستخدم الملاحظة (لو موجودة) لتحسين الـ match
const queryText = note && note.trim().length > 0 ? note : "car image";
autoKnowledgeText = findRelevantIssues(queryText);
} catch (err) {
console.error("autoKnowledge (image) error:", err);
autoKnowledgeText = null;
}

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for vehicles and mechanical systems.

You will receive:
- An image (as base64)
- Optional user note / description

Rules:
- ALWAYS reply in the SAME LANGUAGE as the user's note if it's provided, otherwise infer from your own response.
- Describe briefly what you see.
- Then give the most likely causes for any visible issues.
- Then give step-by-step checks the user can do.
- Then safety advice (when to stop driving / using the machine).
- Be clear, practical, and friendly.
`;

const userText =
note && note.trim().length > 0
? note.trim()
: "The user sent this image and wants to know what might be wrong and what to check.";

const messages = [];

messages.push({ role: "system", content: systemPrompt });

if (autoKnowledgeText) {
messages.push({
role: "system",
content: autoKnowledgeText,
});
}

messages.push({
role: "user",
content: [
{
type: "text",
text: userText,
},
{
type: "image_url",
image_url: {
url: `data:image/jpeg;base64,${imageBase64}`,
},
},
],
});

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

// ============ Supabase logging (اختياري وآمن) ============
try {
const supaModule = await import("../lib/supabaseClient.js");
const logFixLensEvent = supaModule.logFixLensEvent;

if (typeof logFixLensEvent === "function") {
await logFixLensEvent({
source: "mobile-app",
mode,
userMessage: userText,
aiReply: reply,
meta: {
languageHint,
model: "gpt-4.1-mini",
hasImage: true,
},
});
}
} catch (logErr) {
console.error("Supabase image log error (ignored):", logErr);
}
// =========================================================

return res.status(200).json({
code: 200,
message: "OK",
reply,
});
} catch (err) {
console.error("FixLens Brain image-diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
