// api/image-diagnose.js
import OpenAI from "openai";
import { logFixLensEvent } from "../lib/supabaseClient.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "Method not allowed" });
}

try {
const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

const imageBase64 = body.imageBase64 || body.image || "";
const userNote = body.note || body.message || "";

if (!imageBase64) {
return res.status(400).json({
code: 400,
message: "imageBase64 required.",
});
}

const imgDataUrl = `data:image/jpeg;base64,${imageBase64}`;

const systemPrompt = `
You are FixLens Brain – a vision diagnostic assistant.
- You see a photo related to a car, appliance, or mechanical issue.
- Describe what you see.
- Then explain what might be wrong and suggest the next steps.
- If the user note is provided, use it too.
- Reply in the same language as the user's note if possible.
`;

const messages = [
{ role: "system", content: systemPrompt },
userNote
? {
role: "user",
content: userNote,
}
: null,
{
role: "user",
content: [
{ type: "text", text: "Analyze this image and help with diagnosis." },
{
type: "image_url",
image_url: { url: imgDataUrl },
},
],
},
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.4,
});

const reply = completion.choices[0]?.message?.content?.trim() || "";

logFixLensEvent({
source: "mobile-app",
mode: "image",
userMessage: userNote || "[image only]",
aiReply: reply,
meta: { hasImage: true },
}).catch(() => {});

return res.status(200).json({ code: 200, message: "OK", reply });
} catch (err) {
console.error("FixLens Brain image-diagnose error:", err);
return res.status(500).json({
code: 500,
message: "A server error has occurred",
});
}
}
