// api/audio-diagnose.js
// Receives: { audioBase64: string }
import { openai, runFixLensBrain } from "../lib/fixlensBrain.js";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { audioBase64 } = req.body || {};
if (!audioBase64 || typeof audioBase64 !== "string") {
return res.status(400).json({ error: "Field 'audioBase64' is required." });
}

const buffer = Buffer.from(audioBase64, "base64");

// Node 18+ has Blob/File globally
const file = new File([buffer], "audio.m4a", { type: "audio/m4a" });

const transcription = await openai.audio.transcriptions.create({
file,
model: "whisper-1",
response_format: "verbose_json",
});

const text = transcription.text || "";
console.log("Audio transcription:", text);

const result = await runFixLensBrain({
mode: "audio",
text,
audioTranscription: text,
});

return res.status(200).json(result);
} catch (err) {
console.error("audio-diagnose error:", err);
return res
.status(500)
.json({ error: "Internal error in audio-diagnose", details: String(err) });
}
}
