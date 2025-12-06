// api/audio-diagnose.js
// Temporary voice-diagnosis endpoint (no real audio decoding yet)
// هدفه الآن: لا يعطي Error، ويرجع شرح مفيد ويرشد المستخدم يكتب مشكلته بالنص أيضًا.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FIXLENS_MODEL = process.env.FIXLENS_MODEL || "gpt-4.1-mini";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

if (!OPENAI_API_KEY) {
return res
.status(500)
.json({ error: "Missing OPENAI_API_KEY in environment." });
}

try {
const { audio } = req.body || {};

// حالياً لا نحلل الـ audio فعلياً، فقط نؤكّد استلامه
const systemPrompt = `
You are FixLens Auto, an expert automotive assistant.

For now, the mobile app sends you a voice recording from the driver but you cannot decode raw audio yet.

Your task:
- Explain kindly that the voice note was received.
- Ask the driver to type a short description of the problem in text so you can give a more accurate diagnosis.
- Give a short list of examples of what details are helpful (noises, smells, warning lights, speed, weather, etc.).
- Keep it friendly, encouraging, and **short**.
- Answer in English only.
`;

const userPrompt = `
The driver recorded a voice note about their car issue.
Raw audio base64 size: ${audio ? String(audio).length : "no audio received"} characters.
`;

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
temperature: 0.5,
messages: [
{ role: "system", content: systemPrompt },
{ role: "user", content: userPrompt },
],
}),
}
);

if (!openaiRes.ok) {
const errText = await openaiRes.text();
console.error("OpenAI error (audio):", errText);
return res
.status(500)
.json({ error: "FixLens Audio Brain error", details: errText });
}

const data = await openaiRes.json();
const reply =
data?.choices?.[0]?.message?.content?.trim() ||
"I received your voice note. For now, please also type a short description of the problem so I can help you better.";

return res.status(200).json({ reply });
} catch (err) {
console.error("audio-diagnose handler error:", err);
return res
.status(500)
.json({ error: "Server error", details: String(err) });
}
}
