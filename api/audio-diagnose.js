// api/audio-diagnose.js

import OpenAI from "openai";
import { Buffer } from "buffer";
import handlerDiagnose from "./diagnose.js"; // نعيد استخدام نفس المحرك داخليًا

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

export const config = {
api: {
bodyParser: {
sizeLimit: "15mb", // مساحة كافية لتسجيلات قصيرة
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

const audioBuffer = Buffer.from(audioBase64, "base64");

// 1) تحويل الصوت إلى نص
const transcription = await openai.audio.transcriptions.create({
file: {
data: audioBuffer,
name: `fixlens-voice.${mimeType.split("/")[1] || "m4a"}`,
},
model: "whisper-1",
// language: "auto", // يكتشف اللغة تلقائيًا
});

const transcriptText = transcription.text?.trim() || "";

if (!transcriptText) {
return res.status(200).json({
ok: true,
source: "audio",
transcript: "",
answer:
"I could not understand the voice note clearly. Please try again with a clearer recording or type the problem in text.",
});
}

// 2) نمرر النص لمحرك التشخيص نفسه (بطريقة داخلية)
// نصنع req/res وهمية بسيطة
const fakeReq = {
method: "POST",
body: {
message: transcriptText,
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
transcript: transcriptText,
diagnosis: diagnoseResult,
});
} catch (err) {
console.error("FixLens audio-diagnose error:", err);
return res.status(500).json({
ok: false,
error: "Internal error while processing audio diagnosis.",
});
}
}
