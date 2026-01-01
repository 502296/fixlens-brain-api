// service.js
import OpenAI from "openai";
import { DOCTOR_PROMPT } from "./doctorPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensMessage({ sessionId, userText, imageBase64, history = [] }) {
try {
if (!process.env.OPENAI_API_KEY) throw new Error("API Key Missing");

// Constructing the payload for GPT-4o
const content = [{ type: "text", text: userText || "Analyze this vehicle issue." }];

if (imageBase64) {
content.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
});
}

const response = await openai.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: DOCTOR_PROMPT },
...history,
{ role: "user", content: content }
],
temperature: 0.5,
});

const aiReply = response.choices[0].message.content;

if (aiReply.trim() === "ZIP_REQUIRED") {
return {
ok: true,
mode: "need_zip",
text: "Please provide your 5-digit ZIP code to get local parts prices and store locations."
};
}

return { ok: true, text: aiReply, mode: "doctor" };

} catch (error) {
console.error("Service Error:", error.message);
return { ok: false, text: "The Doctor Mechanic is currently unavailable. Please try again." };
}
}
