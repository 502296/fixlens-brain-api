// api/diagnose.js
import OpenAI from "openai";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
try {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

const { text, mode, language } = req.body || {};

if (!text || typeof text !== "string") {
return res.status(400).json({ error: "Missing 'text' in request body" });
}

const userLang = language || "auto";

const systemPrompt = `
You are **FixLens Auto**, an AI assistant that helps users diagnose car issues.

Rules:
- Always reply in the **same language** the user is using (Arabic, English, Spanish, French, etc.).
- Be friendly, short, and clear.
- Ask for more details if the description is not enough.
- Focus on noises, vibrations, warning lights, driving behavior, smells, leaks, starting issues, etc.
- Give **possible causes**, **what to check first**, and **simple next steps**.
- If the problem is dangerous (brakes, steering, fuel leak, smoke, etc.), clearly recommend stopping the car and contacting a professional mechanic or roadside assistance.

Mode info:
- Current mode: ${mode || "text"}
- If the user just says hello or greets you, greet them back first, then ask:
"What is your car issue? Tell me what you notice: sound, vibration, warning light, or behavior."

Language:
- Detect the user's language from the message.
- Answer in that same language.
`.trim();

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: text,
},
],
temperature: 0.7,
max_tokens: 600,
});

const reply =
completion.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a response.";

return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "FixLens Brain internal error",
});
}
}
