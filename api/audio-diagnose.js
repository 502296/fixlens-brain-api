// api/audio-diagnose.js
import OpenAI from "openai";
import { Buffer } from "buffer";
import handlerDiagnose from "./diagnose.js";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export const config = {
api: {
bodyParser: {
sizeLimit: "15mb",
},
},
};

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { audioBase64, mimeType = "audio/m4a", extraContext = {} } =
req.body || {};

if (!audioBase64) {
return res.status(400).json({ error: "audioBase64 is required" });
}

// Decode audio
const audioBuffer = Buffer.from(audioBase64, "base64");

// 1) Transcribe audio (auto-detect language)
const transcription = await openai.audio.transcriptions.create({
file: {
data: audioBuffer,
name: `voice.${mimeType.split("/")[1] || "m4a"}`,
},
model: "whisper-1",
// Whisper automatically detects any language
});

const transcript = transcription.text?.trim() || "";

if (!transcript) {
return res.status(200).json({
ok: true,
source: "audio",
transcript: "",
answer:
"I could not clearly understand the voice note. Please record again or type the issue.",
});
}

// 2) Run the normal diagnosis engine internally
const fakeReq = {
method: "POST",
body: {
message: transcript,
mode: "voice",
extraContext,
},
};

let diagnoseResult = null;

const fakeRes = {
status(code) {
this.statusCode = code;
return this;
},
json(obj) {
diagnoseResult = obj;
return obj;
},
};

await handlerDiagnose(fakeReq, fakeRes);

return res.status(200).json({
ok: true,
source: "audio",
transcript,
diagnosis: diagnoseResult,
});
} catch (err) {
console.error("FixLens audio error:", err);
return res.status(500).json({
ok: false,
error: "Internal error while processing audio.",
});
}
}
