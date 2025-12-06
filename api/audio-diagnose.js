// api/audio-diagnose.js
// FixLens Auto – temporary audio handler
// الهدف: لا نرجّع أخطاء 500 أبداً، ونرجّع رسالة لطيفة تطلب من المستخدم كتابة وصف المشكلة.
// لاحقاً نقدر نطوّره ليحلل الصوت فعلياً (Transcription + Diagnosis).

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

// لو ماكو مفتاح، نرجع رسالة ثابتة بدون AI
if (!OPENAI_API_KEY) {
return res.status(200).json({
reply:
"I received your voice note, but I can't analyze audio yet. Please type a short description of your car issue so I can help you with a proper diagnosis.",
});
}

try {
const { languageHint } = req.body || {};

const systemPrompt = `
You are FixLens Auto, an expert vehicle assistant.

You have received a **voice note** from the driver, but you CANNOT listen to or analyze audio yet.
Your job:
- Politely thank the driver for sending the voice note.
- Explain that you currently cannot analyze audio.
- Ask them to type a short description of the problem (noises, warning lights, leaks, smells, when it happens, etc.).
- ALWAYS respond in the same language as the driver, if possible.
- Be short, clear, and friendly.
Do NOT mention that you are an AI model.
`;

// نستخدم languageHint لو حاب تضيفه من التطبيق، وإلا نرسل رسالة عامة
const userPrompt =
languageHint && typeof languageHint === "string"
? `The driver speaks: ${languageHint}. Please respond in that language.`
: "The driver sent a voice note about a car problem, but we have no text. Please respond in a neutral way and ask them to type a description.";

const openaiRes = await fetch(
"https://api.openai.com/v1/chat/completions",
{
method: "POST",
headers: {
Authorization: `Bearer ${OPENAI_API_KEY}`,
"Content-Type": "application/json",
},
body: JSON.stringify({
model: FIXLENS_MODEL,
temperature: 0.4,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
],
}),
}
);

if (!openaiRes.ok) {
const errText = await openaiRes.text();
console.error("OpenAI audio placeholder error:", errText);
// حتى لو صار خطأ من OpenAI، ما نطيح الـ app: نرجع رسالة ثابتة لطيفة.
return res.status(200).json({
reply:
"Thanks for your voice note. I couldn't process the audio right now, but if you type a short description of the issue, I’ll gladly help you diagnose it.",
});
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"Thanks for your voice note. Please type a short description of the issue so I can help you diagnose it.";

// شكل الرد متطابق مع diagnose.js: { reply: "..." }
return res.status(200).json({ reply });
} catch (err) {
console.error("audio-diagnose handler error:", err);
// حتى في حالة خطأ بالسيرفر، نرجع 200 مع رسالة مفهومة، حتى لا يظهر status 500 داخل التطبيق
return res.status(200).json({
reply:
"Thanks for your voice note. I couldn't analyze the audio, but if you type a short description of the problem, I’ll help you figure out what might be going on.",
});
}
}
