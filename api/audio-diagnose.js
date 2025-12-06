import OpenAI from "openai";

export default async function handler(req, res) {
try {
const { audioBase64 } = req.body;

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

const transcription = await client.audio.transcriptions.create({
file: Buffer.from(audioBase64, "base64"),
model: "gpt-4o-mini-tts",
});

return res.status(200).json({
success: true,
transcription: transcription.text,
});

} catch (error) {
console.error("Audio Transcription Error:", error);
return res.status(500).json({
success: false,
error: error.message,
});
}
}
