import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// 🔥 Auto-language Detection + Same-language reply
function buildPrompt(userMessage, lang) {
return `
You are FixLens, an AI vehicle diagnostic assistant.

User language: ${lang}

Your rules:
- Detect the user's language and ALWAYS respond in the same language.
- Give structured, professional, clear automotive diagnostics.
- If the user provides an image, include image-based diagnosis.
- If information is missing, ask for EXACT details but stay friendly.
- Do NOT say “I need more details” — instead tell them what EXACT info you need.
- Stay concise but helpful.

User message:
${userMessage}
`;
}

export default async function handler(req, res) {
try {
const { message, imageBase64, audioTranscription } = req.body;

let finalUserMessage = message || "";
if (audioTranscription) {
finalUserMessage += `\n(Voice description: ${audioTranscription})`;
}

// Detect language using OpenAI
const langDetection = await client.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: "Detect the language of the user message and reply with only the language name (e.g. English, Arabic, Spanish)." },
{ role: "user", content: finalUserMessage }
]
});

const detectedLang = langDetection.choices[0].message.content.trim();

let imageInput = null;
if (imageBase64) {
imageInput = {
type: "input_image",
image_url: `data:image/jpeg;base64,${imageBase64}`,
};
}

// AI diagnosis
const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: buildPrompt(finalUserMessage, detectedLang) },
imageInput ? { role: "user", content: [imageInput, { type: "text", text: finalUserMessage }] }
: { role: "user", content: finalUserMessage }
]
});

const aiResponse = completion.choices[0].message.content;

return res.status(200).json({
success: true,
language: detectedLang,
response: aiResponse
});

} catch (error) {
console.error("FixLens AI Error:", error);
return res.status(500).json({
success: false,
error: "AI processing failed",
details: error.message,
});
}
}
