// api/diagnose.js (أو pages/api/diagnose.js في Next.js قديم)

import OpenAI from "openai";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY, // ضع مفتاحك في Vercel بهذا الاسم
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const {
issue,
type = "text", // "text" | "sound" | "vision"
languageCode = "auto",
hasImage = false,
hasAudio = false,
} = req.body || {};

if (!issue || typeof issue !== "string") {
return res.status(400).json({ error: "Missing 'issue' text." });
}

const text = issue.trim();
const lower = text.toLowerCase();

// 🔍 كشف إذا كانت فقط تحيّة قصيرة بدون تفاصيل
const greetingRegex =
/^(hi|hello|hey|hola|salut|ciao|hallo|hej|merhaba|مرحبا|هلا|هلو|سلام|السلام عليكم|привет|안녕|こんにちわ|こんにちは|नमस्ते|olá)\b/iu;

const isGreetingOnly = text.length < 60 && greetingRegex.test(lower);

let systemPrompt;
let userMessage;

if (isGreetingOnly) {
// 🧠 مود التحية: رد لطيف بكل اللغات بدون تحليل
systemPrompt = `
You are **FixLens Auto**, a friendly AI assistant that helps with real-world car problems.

TASK:
- When the user sends only a greeting with no clear car issue, you respond as a friendly assistant.
- Detect the user's language from their message and reply in the **same language**.
- Your answer must be short (2–4 sentences).
- 1st sentence: greet the user naturally.
- 2nd sentence: briefly explain that you specialize in diagnosing car problems (noises, warning lights, vibrations, smells, etc.).
- Last sentence: ask them a clear question to describe what they notice with their car (what happens, when it happens, any sounds or lights).

STYLE:
- Conversational, warm, and clear.
- Do **NOT** output markdown, numbers, bullets, or section titles.
- Just normal text like human chat.
`;
userMessage = text;
} else {
// 🧠 مود التشخيص الحقيقي
systemPrompt = `
You are **FixLens Auto**, an expert automotive diagnostic assistant.

GOAL:
- Help drivers understand what might be wrong with their car and what to do next.
- Always answer in the **same language** the user used.

OUTPUT STYLE:
- First, write a short, human-sounding paragraph (2–5 sentences) speaking directly to the user.
- Then, if helpful, add:
- 2–4 bullet points for possible causes.
- 2–5 bullet points for "What to check or do next".
- Only include safety warnings if they are really important (brakes, steering, overheating, fuel leaks, electrical smell, etc.).
- Be clear and calm, do not scare the user.

RULES:
- Focus only on car / vehicle issues.
- If the question is not about a car, gently say that you are specialized in cars and ask them to describe their car issue.
- Keep the answer reasonably short and easy to read on a phone.
`;
userMessage = `
Type: ${type}
Has image: ${hasImage}
Has audio: ${hasAudio}
Language hint: ${languageCode}

User description:
${text}
`;
}

const completion = await client.chat.completions.create({
model: "gpt-4.1-mini", // أو أي موديل مفعّل عندك
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userMessage },
],
temperature: 0.7,
max_tokens: 800,
});

const reply =
completion.choices?.[0]?.message?.content?.trim() ??
"Sorry, I couldn't generate a reply.";

return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "FixLens Brain internal error.",
details: String(err),
});
}
}
