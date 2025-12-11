// api/audio-diagnose.js
import OpenAI from "openai";
import fs from "fs";

export const config = {
runtime: "nodejs18.x",
bodyParser: false
};

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
try {
if (req.method !== "POST") {
return res.status(405).json({ error: "POST only" });
}

const chunks = [];
for await (const chunk of req) chunks.push(chunk);
const buffer = Buffer.concat(chunks);

// OpenAI requires MP3
const ai = await client.chat.completions.create({
model: "gpt-4.1",
messages: [
{
role: "user",
content: [
{ type: "text", text: "Analyze this engine sound." },
{
type: "input_audio",
audio: buffer,
mime_type: "audio/mp3"
}
]
}
]
});

return res.status(200).json({
reply: ai.choices[0].message.content
});

} catch (err) {
console.error("AUDIO ERROR:", err);
return res.status(500).json({
error: "FixLens audio failed",
details: err.message
});
}
}
