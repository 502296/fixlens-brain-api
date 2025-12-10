// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// --------------------------------------------------
// Helper: guess user language from text
// --------------------------------------------------
function guessLanguage(text) {
if (!text || !text.trim()) return null;
const t = text.trim();

// Arabic
if (/[\u0600-\u06FF]/.test(t)) return "ar";
// Russian
if (/[\u0400-\u04FF]/.test(t)) return "ru";
// Greek
if (/[\u0370-\u03FF]/.test(t)) return "el";
// Chinese / Japanese / Korean (CJK)
if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
if (/[\u3040-\u30FF]/.test(t)) return "ja";
if (/[\uAC00-\uD7AF]/.test(t)) return "ko";

// Simple Latin-based language hints
const lower = t.toLowerCase();
if (/[áéíóúñ¿¡]/.test(lower)) return "es"; // Spanish
if (/[àâçéèêëîïôûùüÿœ]/.test(lower)) return "fr"; // French
if (/[äöüß]/.test(lower)) return "de"; // German
if (/[ãõç]/.test(lower)) return "pt"; // Portuguese
if (/[ğüşöçıİ]/i.test(lower)) return "tr"; // Turkish
if (/[अ-ह]/.test(lower)) return "hi"; // Hindi / Devanagari

return "en";
}

// --------------------------------------------------
// Helper: build system + user prompt
// --------------------------------------------------
function buildUserPrompt(textDescription, relevantIssues, language) {
const baseIntro =
language === "ar"
? `أنت FixLens Auto، مساعد تشخيص ذكي لمشاكل السيارات. معك صورة لمكوّن في السيارة، وربما ملاحظة قصيرة من المستخدم. استخدم الصورة أولاً، ثم استخدم أي نص مكتوب لتفهم المشكلة.`
: `You are FixLens Auto, an intelligent car diagnostics assistant. You have an image of a car component and an optional short text note from the user. Use the image first, then the text, to understand the problem.`;

const kbPart =
relevantIssues && relevantIssues.length
? `\n\nHere is a shortlist of potentially relevant issues from the FixLens auto knowledge base (JSON):\n${JSON.stringify(
relevantIssues,
null,
2
)}\n\nUse these only as hints – do NOT assume they are always correct.`
: "";

const userNote = textDescription
? `\n\nUser's note / description:\n"${textDescription}"`
: "";

const structure =
language === "ar"
? `\n\nرجاءً أعد الإجابة بالهيكل التالي دائمًا وبشكل مرتب وواضح:\n\n**Quick Summary:**\nملخص قصير وبسيط لما تراه في الصورة وما تعتقد أنه يحدث.\n\n**Most Likely Causes:**\nنقاط مرقّمة لأكثر الأسباب احتمالاً.\n\n**Recommended Next Steps:**\nخطوات عملية يقترحها FixLens Auto للمتابعة.\n\n**Safety Warnings (إن وجد):**\nأي تحذيرات مهمّة تتعلق بالأمان.`
: `\n\nPlease always answer using the following structured sections:\n\n**Quick Summary:**\nShort, simple explanation of what you see and what might be happening.\n\n**Most Likely Causes:**\nNumbered list of the most likely causes.\n\n**Recommended Next Steps:**\nPractical actions the driver should take.\n\n**Safety Warnings (if any):**\nAny important safety-related notes.`;

return `${baseIntro}${kbPart}${userNote}${structure}`;
}

// --------------------------------------------------
// Main handler
// --------------------------------------------------
export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ code: 405, message: "Method not allowed. Use POST." });
}

try {
const { image, text, language: clientLanguage } = req.body || {};

if (!image || typeof image !== "string") {
return res
.status(400)
.json({ code: 400, message: "Missing 'image' (base64 string)." });
}

// Detect / choose language
const lang = clientLanguage || guessLanguage(text) || "en";

// Prepare base64 data URL for vision
// Flutter can send either:
// 1) pure base64: "iVBORw0KGgoAAAANSUhEUgAA..."
// 2) full data URL: "data:image/jpeg;base64,...."
const imageUrl = image.startsWith("data:")
? image
: `data:image/jpeg;base64,${image}`;

// Load relevant issues from autoKnowledge based on the user's text description
const relevantIssues = await findRelevantIssues(text || "");

const userPrompt = buildUserPrompt(text, relevantIssues, lang);

// ------------------ OpenAI Vision Call ------------------
const completion = await openai.chat.completions.create({
model: "gpt-4o-mini", // supports vision + languages + cost-efficient
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are FixLens Auto, a calm and friendly global car diagnostics assistant. Always be honest about uncertainty and never guess the exact part if you are not sure.",
},
{
role: "user",
content: [
{
type: "text",
text: userPrompt,
},
{
type: "image_url",
image_url: {
url: imageUrl,
},
},
],
},
],
});

let replyText = "";

// Vision responses with chat.completions return an array of content parts
const msg = completion.choices?.[0]?.message;
if (Array.isArray(msg?.content)) {
replyText =
msg.content
.map((part) => (part.type === "text" ? part.text : ""))
.join("\n")
.trim() || "";
} else if (typeof msg?.content === "string") {
replyText = msg.content;
}

if (!replyText) {
replyText =
lang === "ar"
? "لم أتمكّن من تحليل هذه الصورة بشكل واضح. جرّب زاوية أخرى، أو اضف وصفًا كتابيًا للمشكلة."
: "I couldn't confidently analyze this image. Please try another angle or add a short text description of the problem.";
}

return res.status(200).json({
reply: replyText,
language: lang,
issues: relevantIssues || [],
source: "fixlens-image",
});
} catch (error) {
console.error("FixLens image diagnose error:", error);

const message =
error?.response?.data?.error?.message ||
error?.message ||
"A server error has occurred";

return res.status(500).json({
code: 500,
message,
});
}
}
