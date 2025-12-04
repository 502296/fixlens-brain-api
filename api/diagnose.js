// api/diagnose.js

import OpenAI from "openai";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

try {
const { message } = req.body || {};

if (!message || typeof message !== "string") {
return res
.status(400)
.json({ error: 'Body must include a "message" string.' });
}

// هنا نقدر لاحقاً نضيف قراءة من car.json و car_extra.json
// لكن الآن خليه رد ذكي مباشر
const completion = await client.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{
role: "system",
content:
"You are FixLens Auto, an AI car diagnostics assistant. Ask for key details (car, model, year, symptoms) and give clear step-by-step checks and safety notes. Be concise and helpful.",
},
{
role: "user",
content: message,
},
],
});

const reply =
completion.choices?.[0]?.message?.content ??
"I need a bit more detail about the car issue. Describe the sound, warning lights, or symptoms.";

return res.status(200).json({ response: reply });
} catch (error) {
console.error("FixLens diagnose error:", error);
return res.status(500).json({ error: "Internal server error" });
}
}
