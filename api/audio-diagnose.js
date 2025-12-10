// api/audio-diagnose.js
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
// Helper: build user prompt from transcript
// --------------------------------------------------
function buildUserPromptFromTranscript(transcript, relevantIssues, language) {
const baseIntro =
language === "ar"
? `أنت FixLens Auto، مساعد ذكي متخصص فقط في تشخيص مشاكل السيارات (المحركات، أنظمة الوقود، الإشعال، الأصوات، الاهتزازات، التسريبات، أضواء التحذير، إلخ). لا تقدّم نصيحة لأي نوع آخر من الأجهزة أو الأجهزة المنزلية.\n\nأمامك الآن النص التالي الذي تم تفريغه من رسالة صوتية للمستخدم. استخدمه لفهم المشكلة التي يواجهها في سيارته:`
: `You are FixLens Auto, an intelligent assistant that ONLY diagnoses issues for vehicles (cars, SUVs, trucks). Do NOT talk about appliances, home devices, or unrelated equipment.\n\nYou are given the transcribed text from the user's voice note. Use it to understand what problem they are experiencing with their car:`;

const kbPart =
relevantIssues && relevantIssues.length
? `\n\nHere is a shortlist of potentially relevant issues from the FixLens auto knowledge base (JSON). Use these only as hints:\n${JSON.stringify(
relevantIssues,
null,
2
)}`
: "";

const structure =
language === "ar"
? `\n\nرجاءً أجب دائمًا بالهيكل التالي، وبنفس لغة المستخدم قدر الإمكان:\n\n**Quick Summary:**\nملخص قصير وبسيط لما فهمته من وصف المستخدم.\n\n**Most Likely Causes:**\nقائمة مرقّمة لأكثر الأسباب المحتملة للمشكلة في السيارة.\n\n**Recommended Next Steps:**\nخطوات عملية يمكن للسائق القيام بها الآن أو خلال الفترة القادمة.\n\n**Safety Warnings (إن وجدت):**\nأي تحذيرات خاصة بالأمان مثل متى يُفضّل التوقف عن القيادة أو الإسراع بالذهاب إلى ميكانيكي.`
: `\n\nAlways answer using the structure below, in the same language as the user when possible:\n\n**Quick Summary:**\nShort and simple explanation of what you understood from the user's description.\n\n**Most Likely Causes:**\nNumbered list of the most likely car-related causes.\n\n**Recommended Next Steps:**\nPractical steps the driver can take now or soon.\n\n**Safety Warnings (if any):**\nAny important safety advice, such as when to stop driving or seek urgent inspection.`;

return `${baseIntro}\n\n"${transcript}"${kbPart}${structure}`;
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
const { audioBase64, mimeType, language: clientLanguage } = req.body || {};

if (!audioBase64 || typeof audioBase64 !== "string") {
return res.status(400).json({
code: 400,
message: "Missing 'audioBase64' field (base64 string).",
});
}

const buffer = Buffer.from(audioBase64, "base64");
const audioType = mimeType || "audio/m4a";

// ------------------ 1) Transcribe audio ------------------
const file = new File([buffer], "audio.m4a", { type: audioType });

const transcription = await openai.audio.transcriptions.create({
file,
model: "gpt-4o-transcribe",
});

const transcriptText = (transcription.text || "").trim();

if (!transcriptText) {
return res.status(200).json({
reply:
"I couldn't understand the audio clearly. Please try again and describe the car problem a bit more.",
language: "en",
source: "fixlens-audio",
});
}

// Decide language (client explicit > guessed from transcript > default en)
const lang =
clientLanguage && clientLanguage !== "auto"
? clientLanguage
: guessLanguage(transcriptText) || "en";

// ------------------ 2) Use autoKnowledge for hints ------------------
const relevantIssues = await findRelevantIssues(transcriptText);

const userPrompt = buildUserPromptFromTranscript(
transcriptText,
relevantIssues,
lang
);

// ------------------ 3) Chat completion for structured answer --------
const completion = await openai.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.4,
messages: [
{
role: "system",
content:
"You are FixLens Auto, a calm and friendly global car diagnostics assistant. You ONLY provide help for cars and vehicles, never for home appliances or unrelated devices. Always be honest about uncertainty and never overstate your confidence.",
},
{
role: "user",
content: userPrompt,
},
],
});

const msg = completion.choices?.[0]?.message;
let replyText = "";

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
? "تم استلام الرسالة الصوتية لكن لم أستطع فهم المشكلة بشكل واضح. رجاءً أعد تسجيل وصف للمشكلة في سيارتك بصوت أوضح أو استخدم الكتابة."
: "I received the voice note but couldn't clearly understand the problem. Please try again with a clearer description of what's happening with your car, or use text.";
}

return res.status(200).json({
reply: replyText,
language: lang,
transcript: transcriptText,
issues: relevantIssues || [],
source: "fixlens-audio",
});
} catch (error) {
console.error("FixLens audio diagnose error:", error);

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
