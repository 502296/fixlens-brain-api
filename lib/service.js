// service.js
import OpenAI from "openai";
import { DOCTOR_PROMPT } from "./doctorPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensMessage({ sessionId, userText, imageBase64, history = [] }) {
try {
if (!process.env.OPENAI_API_KEY) {
throw new Error("OpenAI API Key is missing in environment variables.");
}

// Prepare content with text and optional image
const userMessageContent = [
{ type: "text", text: userText || "Analyze this vehicle situation." }
];

if (imageBase64) {
userMessageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
});
}

const messages = [
{ role: "system", content: DOCTOR_PROMPT },
...history,
{ role: "user", content: userMessageContent }
];

const completion = await openai.chat.completions.create({
model: "gpt-4o", // Essential for vision and high-quality multilingual support
messages: messages,
max_tokens: 600,
temperature: 0.5
});

const assistantReply = completion.choices[0].message.content;

// Clean logic for ZIP requirement
if (assistantReply.trim() === "ZIP_REQUIRED") {
return {
ok: true,
mode: "need_zip",
text: "Please provide your 5-digit ZIP code so I can locate the best prices and nearest stores for you."
};
}

return { ok: true, text: assistantReply, mode: "doctor" };

} catch (error) {
console.error("FixLens Service Error:", error.message);
return {
ok: false,
error: "SERVICE_ERROR",
text: "I'm having trouble connecting to the diagnostic brain. Please try again in a moment."
};
}
}
