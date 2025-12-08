// api/image-diagnose.js
// Handle car-image diagnosis using OpenAI Vision (Responses API)

import OpenAI from "openai";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { imageBase64, userText } = req.body || {};

if (!imageBase64 || typeof imageBase64 !== "string") {
return res.status(400).json({
error: "Field 'imageBase64' (base64 image) is required.",
});
}

// نحوله لصيغة data URL يفهمها GPT-4o Vision
const imageUrl = `data:image/jpeg;base64,${imageBase64}`;

const prompt =
(userText && userText.trim().length > 0
? `The user sent this car photo and said: "${userText}".`
: "The user sent this photo of a car issue.") +
" You are FixLens Auto, a friendly global mechanic assistant. " +
"Explain in simple language what you see, what might be wrong, " +
"and what steps the user can take next. " +
"Always be clear that this is not a final professional diagnosis.";

const response = await client.responses.create({
model: "gpt-4.1-mini",
input: [
{
role: "user",
content: [
{ type: "input_text", text: prompt },
{
type: "input_image",
image_url: imageUrl,
},
],
},
],
});

// نحاول استخراج النص من output بأكثر طريقة آمنة
let replyText = "I analyzed the image but could not generate a response.";
try {
const first = response.output[0];
const firstContent = first?.content?.[0];
if (firstContent?.type === "output_text") {
replyText = firstContent.text;
}
} catch (err) {
console.error("Parse image response error:", err);
}

return res.status(200).json({
reply: replyText,
language: "auto",
mode: "image",
domain: "auto",
});
} catch (err) {
console.error("image-diagnose internal error:", err);
return res.status(500).json({
error: "Internal error in image-diagnose",
details: String(err),
});
}
}
