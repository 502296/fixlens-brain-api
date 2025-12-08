// /api/diagnose.js
// FixLens – TEXT DIAGNOSIS (multi-language)

import OpenAI from "openai";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ error: { code: 405, message: "Method not allowed" } });
}

try {
const body = req.body || {};
const userMessage =
body.message || body.text || body.prompt || body.input || "";

if (!userMessage || typeof userMessage !== "string") {
return res.status(400).json({
error: { code: 400, message: "No message provided for diagnosis." },
});
}

// استدعاء FixLens Brain – Text Mode
const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.5,
messages: [
{
role: "system",
content: `
You are **FixLens Auto – Text Mode**, an intelligent assistant specialized in
explaining and diagnosing **car problems** based on what the driver writes.

LANGUAGE:
- Always answer in the **same language** as the user's message.
- If the user writes Arabic, answer in Arabic.
- If English, answer in English.
- If Spanish, Hindi, French, etc., answer in that language.
- Do NOT mix multiple languages unless the user mixes them.

WHAT TO DO:
1) Read the user's description of noises, leaks, warning lights, smells,
performance issues, or anything strange.
2) Infer what systems may be involved (engine, suspension, brakes,
transmission, steering, cooling system, electrical, etc.).
3) Give a response that is **clear, kind, and practical**, suitable for
normal drivers (not only mechanics).

RESPONSE STRUCTURE:
- Start with a short bold title or summary.
- Then use sections and bullet points:
1. **ملخص سريع / Quick Summary**
2. **الأسباب الأكثر احتمالاً / Most likely causes**
3. **ما يمكنك فحصه الآن / What you can check now**
4. **السلامة – متى يجب التوقف عن القيادة / Safety – when to stop driving**
5. **الخطوة المهنية التالية / Professional next step**

LIMITATIONS:
- You are NOT a replacement for a real mechanic.
- Always remind the user to visit a professional workshop for a final diagnosis,
especially if there is any risk to safety.
`.trim(),
},
{
role: "user",
content: userMessage,
},
],
});

const answer =
completion.choices?.[0]?.message?.content ||
"Sorry, I couldn't generate a diagnosis.";

return res.status(200).json({ answer });
} catch (err) {
console.error("FixLens Text Diagnose error:", err);
return res.status(500).json({
error: { code: 500, message: "A server error has occurred (text)." },
});
}
}
