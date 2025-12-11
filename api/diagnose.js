// api/diagnose.js
// FixLens – TEXT DIAGNOSIS (Global, multi-language)

import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// Helper: clean text
function cleanText(value) {
if (!value) return "";
if (typeof value === "string") return value.trim();
return String(value).trim();
}

// Helper: guess language from user message (NOT from reply)
function guessLanguage(text) {
if (!text || !text.trim()) return null;
const t = text.trim();

// Arabic
if (/[\u0600-\u06FF]/.test(t)) return "ar";
// Russian
if (/[\u0400-\u04FF]/.test(t)) return "ru";
// Greek
if (/[\u0370-\u03FF]/.test(t)) return "el";
// CJK
if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
if (/[\u3040-\u30FF]/.test(t)) return "ja";
if (/[\uAC00-\uD7AF]/.test(t)) return "ko";

const lower = t.toLowerCase();

if (/[áéíóúñ¿¡]/.test(lower)) return "es"; // Spanish
if (/[àâçéèêëîïôûùüÿœ]/.test(lower)) return "fr"; // French
if (/[äöüß]/.test(lower)) return "de"; // German
if (/[ãõç]/.test(lower)) return "pt"; // Portuguese
if (/[ğüşöçıİ]/i.test(lower)) return "tr"; // Turkish
if (/[अ-ह]/.test(lower)) return "hi"; // Hindi / Devanagari

return "en";
}

// Helper: safe logging to Supabase (doesn't break API if logging fails)
async function safeLogFixLensEvent(payload) {
try {
const mod = await import("../lib/supabaseClient.js");
const fn = mod.logFixLensEvent;
if (typeof fn === "function") {
await fn(payload);
} else {
console.error("logFixLensEvent is not a function (ignored).");
}
} catch (e) {
console.error("Supabase logging error (ignored):", e.message);
}
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ code: 405, message: "Method not allowed. Use POST." });
}

const started = Date.now();
const mode = "text";

try {
let body = req.body;

if (typeof body === "string") {
try {
body = JSON.parse(body);
} catch {
// keep as string if JSON.parse fails
}
}

const message = cleanText(body?.message || body?.text || body?.prompt);
const languageHintRaw = cleanText(body?.languageHint || body?.lang || body?.preferredLanguage);

if (!message) {
return res
.status(400)
.json({ code: 400, message: "message is required in request body." });
}

// Decide final language: Flutter hint > auto-detect from user message > default en
const userLanguage =
(languageHintRaw && languageHintRaw !== "auto" && languageHintRaw) ||
guessLanguage(message) ||
"en";

// Load knowledge base
let issuesSummary = "No matched issues from the knowledge base.";
try {
const issues = await findRelevantIssues(message);
if (issues && issues.length > 0) {
issuesSummary = JSON.stringify(issues, null, 2);
}
} catch (err) {
console.error("autoKnowledge error:", err);
issuesSummary = "Knowledge base unavailable (internal error).";
}

const systemPrompt = `
You are FixLens Auto, a global intelligent automotive assistant.

USER LANGUAGE:
- The user's language code is: "${userLanguage}".
- ALWAYS answer ONLY in this language. Never switch to a different language.

DOMAIN:
- You specialize in car problems: noises, leaks, warning lights, vibrations, smells,
starting issues, rough idle, shaking, braking issues, steering, and other common symptoms.
- Use the "reference issues" below only as internal hints. Don't show raw JSON to the user.
- Your answer must be friendly, clear, and not scary, but honest about safety.

REPLY STRUCTURE (in the user's language):
1) Short friendly greeting.
2) Brief summary of what might be happening (1–3 sentences).
3) 2–4 likely causes with simple explanations (bullet points).
4) 3–5 practical next steps (what the driver should check, how urgent it is,
and whether it's safe to drive or should tow the car).
5) Always add a short safety note: this is not a replacement for an in-person mechanic.

If the user message is just "hello" or something very short with no symptoms,
gently introduce yourself, explain what FixLens can do, and ask them to describe the issue.

If the user is NOT talking about cars at all, give a short polite answer
in their language, and then remind them that FixLens Auto is mainly for cars.
`.trim();

const combinedPrompt = `
System instructions:
${systemPrompt}

User message (in ${userLanguage}):
${message}

Language hint:
${userLanguage}

Reference issues from autoKnowledge (for your internal reasoning only):
${issuesSummary}
`.trim();

const response = await openai.responses.create({
model: "gpt-5.1-mini", // 🔥 قوي وسريع ومتعدد اللغات
input: combinedPrompt,
max_output_tokens: 900,
});

const replyText = cleanText(response.output_text);

const latencyMs = Date.now() - started;

// Log to Supabase (non-blocking)
safeLogFixLensEvent({
source: "mobile-app",
mode,
userMessage: message,
aiReply: replyText,
meta: {
endpoint: "/api/diagnose",
language: userLanguage,
model: "gpt-5.1-mini",
latencyMs,
success: true,
},
});

return res.status(200).json({
code: 200,
message: "OK",
reply: replyText || "FixLens Auto could not generate a reply.",
language: userLanguage, // 👈 نفس لغة المستخدم
});
} catch (err) {
console.error("FixLens diagnose.js error:", err);

const latencyMs = Date.now() - started;

safeLogFixLensEvent({
source: "mobile-app",
mode,
userMessage: null,
aiReply: null,
meta: {
endpoint: "/api/diagnose",
error: String(err?.message || err),
latencyMs,
success: false,
},
});

return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development"
? String(err?.stack || err?.message || err)
: undefined,
});
}
}
