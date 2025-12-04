// /api/diagnose.js
import OpenAI from "openai";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const {
issue,
type = "text",
languageCode = "en",
hasImage = false,
hasAudio = false,
} = req.body || {};

if (!issue || typeof issue !== "string") {
return res.status(400).json({ error: "Missing 'issue' in body." });
}

const trimmed = issue.trim();

// 1) 👋 كشف سريع إذا كانت الرسالة مجرد تحية قصيرة بأي لغة تقريباً
const isShort = trimmed.split(/\s+/).length <= 4;
const greetings = [
"hello",
"hi",
"hey",
"سلام",
"هلو",
"مرحبا",
"مرحبا",
"bonjour",
"hola",
"ciao",
"hallo",
"ola",
"привет",
"مرحباً",
"selam",
"こんにちは",
"안녕하세요",
"你好",
];

const lowered = trimmed.toLowerCase();
const looksLikeGreeting =
isShort && greetings.some((g) => lowered.includes(g));

// 2) لو كانت تحية → نطلب من الموديل رد اجتماعي بسيط بدون فورمات تشخيص
if (looksLikeGreeting) {
const chatResponse = await client.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{
role: "system",
content:
"You are FixLens Auto, a friendly multi-language assistant. " +
"Always answer in the SAME language as the user. " +
"If the user just greets you, reply with a short warm greeting, " +
"introduce yourself as an AI helper for car problems, and ask them " +
"to describe what they feel or hear in the car. " +
"Do NOT return any diagnostic template, bullets, or numbered sections in this mode.",
},
{
role: "user",
content: trimmed,
},
],
temperature: 0.7,
max_tokens: 220,
});

const reply = chatResponse.choices[0]?.message?.content?.trim() ?? "";
return res.status(200).json({ reply });
}

// 3) 🔍 وضع التشخيص المنظم (هذا نستعمله لما الوصف يبدو مشكلة سيارة)
const diagnosisResponse = await client.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{
role: "system",
content:
"You are FixLens Auto, a specialized assistant for real-world vehicle diagnostics. " +
"Always answer in the SAME language that the user uses in their message. " +
"The user describes car symptoms (noises, vibrations, smells, warning lights, etc.). " +
"Return a clear, structured answer with the following sections:\n\n" +
"1) **Summary** – one short paragraph summarizing the issue in simple words.\n" +
"2) **Possible Causes** – 3-7 bullet points of mechanical causes (most likely first).\n" +
"3) **What To Check First** – 1-3 practical checks that a normal driver can start with.\n" +
"4) **Step-by-Step Fix** – a short sequence of steps, from simple checks to more advanced.\n" +
"5) **When To See a Mechanic** – when the user should stop driving and go to a professional.\n" +
"6) **Estimated Severity** – Low / Medium / High in one line.\n" +
"7) **Safety Warnings** – any serious risks (brake failure, fire risk, loss of control, etc.).\n\n" +
"Be concise but practical. Assume modern passenger cars. If the description is very vague, " +
"ask the user for 2-3 clarifying questions instead of inventing details.",
},
{
role: "user",
content: `Type: ${type}. Has image: ${hasImage}. Has audio: ${hasAudio}. Language hint: ${languageCode}. Problem description: ${trimmed}`,
},
],
temperature: 0.4,
max_tokens: 700,
});

const reply =
diagnosisResponse.choices[0]?.message?.content?.trim() ??
"FixLens could not generate a diagnosis.";

return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({ error: "Internal server error" });
}
}
