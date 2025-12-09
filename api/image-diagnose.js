// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { logFixLensEvent } from "../lib/supabaseClient.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

function guessLanguage(text) {
if (!text || !text.trim()) return null;
const t = text.trim();

if (/[\u0600-\u06FF]/.test(t)) return "ar";
if (/[\u0400-\u04FF]/.test(t)) return "ru";
if (/[\u0370-\u03FF]/.test(t)) return "el";
if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

const lower = t.toLowerCase();

if (/[ñáéíóúü]|hola\b|gracias\b|buenos\s+d[ií]as/.test(lower)) return "es";
if (/[àâçéèêëîïôùûüÿœ]|bonjour\b|merci\b/.test(lower)) return "fr";
if (/[äöüß]|hallo\b|danke\b/.test(lower)) return "de";

if (/^[\x00-\x7F]+$/.test(t)) return "en";

return null;
}

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "Method not allowed" });
}

try {
const body =
typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const imageBase64 = body.imageBase64;
const userNote = body.note || body.userText || "";
const languageHint = body.language || "auto";
const mode = "image";

if (!imageBase64) {
return res
.status(400)
.json({ code: 400, message: "imageBase64 is required." });
}

const autoKnowledge = userNote
? findRelevantIssues(userNote)
: null;

let targetLanguage = null;
if (languageHint && languageHint !== "auto") {
targetLanguage = languageHint;
} else {
targetLanguage = guessLanguage(userNote) || "en";
}

const languageInstruction =
targetLanguage === "en"
? "Reply in natural English, unless the note is clearly in another language."
: `Reply strictly in this language: ${targetLanguage}.`;

const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for cars, home appliances, and general mechanical issues.

Language rule:
- ${languageInstruction}
- NEVER switch to another language unless the user clearly switches.
- If there's any Arabic, answer fully in Arabic. If Spanish, answer in Spanish, etc.

General rules:
- You are now analyzing an image related to a possible mechanical/auto issue.
- Describe briefly what you see that is relevant to the problem.
- Then follow the same structure:
- **Quick Summary**
- **Most Likely Causes**
- **What You Can Check Now**
- **Safety / When to Stop Driving or Using the device**
- **Next Professional Step**
- If the user note gives extra context, use it.
- Be honest about uncertainty and give safety warnings when needed.
${autoKnowledge ? "\nInternal hints:\n" + autoKnowledge : ""}
`;

const userText =
userNote && userNote.trim().length > 0
? userNote
: "Please analyze this image and explain any possible issues, in the correct language.";

const messages = [
{
role: "system",
content: systemPrompt,
},
{
role: "user",
content: [
{ type: "text", text: userText },
{
type: "input_image",
image_url: {
url: `data:image/jpeg;base64,${imageBase64}`,
},
},
],
},
];

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.5,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

logFixLensEvent({
source: "mobile-app",
mode,
userMessage: userNote || "[image only]",
aiReply: reply,
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
console.error("FixLens Brain image-diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
details:
process.env.NODE_ENV === "development" ? err.message : undefined,
});
}
}
