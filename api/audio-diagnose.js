// /api/audio-diagnose.js
// FixLens – AUDIO DIAGNOSIS (multi-language sound analysis)

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// نعطل bodyParser لاستقبال ملف
export const config = {
api: {
bodyParser: false,
},
};

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ error: { code: 405, message: "Method not allowed" } });
}

try {
const form = formidable({ multiples: false });

const { files } = await new Promise((resolve, reject) => {
form.parse(req, (err, fields, files) => {
if (err) reject(err);
else resolve({ fields, files });
});
});

// 👇 عدّل الاسم لو كنت تستخدم حقل مختلف من Flutter
const audioFile = files?.audio || files?.file;
if (!audioFile) {
return res
.status(400)
.json({ error: { code: 400, message: "No audio file uploaded." } });
}

const audioStream = fs.createReadStream(audioFile.filepath);

// 1) تفريغ الصوت إلى نص – الموديل يكتشف اللغة تلقائياً
const transcription = await client.audio.transcriptions.create({
model: "gpt-4o-transcribe",
file: audioStream,
});

const transcriptText = (transcription.text || "").trim();
if (!transcriptText) {
return res.status(200).json({
transcript: "",
answer:
"I couldn't understand the audio clearly. Please try again or describe the sound in text.",
});
}

// 2) تحليل النص (نفس اللغة التي تكلم بها المستخدم)
const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.5,
messages: [
{
role: "system",
content: `
You are **FixLens Auto – Sound Mode**, a smart assistant specialized in
diagnosing **car issues based on sound**.

INPUT:
- You receive a transcription of what the user said about the sound.
- The transcription text is in the **same language** the user spoke.

LANGUAGE:
- Always answer in the **same language as the transcription**.
- If the text is Arabic → reply Arabic.
- If English → reply English.
- If Spanish, Hindi, etc. → reply in that language.

WHAT TO DO:
1) Interpret the type of sound (knock, click, squeal, whine, rattle, etc.).
2) Suggest the **most likely causes** (engine internals, belts, pulleys,
suspension, brakes, transmission, exhaust, etc.).
3) Indicate **driving risk**:
- safe for short distance,
- or avoid driving / stop immediately.
4) Suggest **what the user can check now** without special tools.
5) Suggest **the next professional step** (visit mechanic, what to tell them).

STYLE:
- Clear and friendly.
- Use short sections & bullet points:
- وصف الصوت / Sound description
- الأسباب المحتملة / Possible causes
- ما يمكنك فحصه الآن / What you can check now
- السلامة / Safety
- الخطوة المهنية التالية / Professional next step

REMEMBER:
- You are not a replacement for a certified mechanic.
- Emphasize safety if there is any risk (brakes, steering, severe knocks, etc.).
`.trim(),
},
{
role: "user",
content: transcriptText,
},
],
});

const answer =
completion.choices?.[0]?.message?.content ||
"Sorry, I couldn't analyze this sound.";

return res.status(200).json({
transcript: transcriptText,
answer,
});
} catch (err) {
console.error("FixLens Audio Diagnose error:", err);
return res.status(500).json({
error: { code: 500, message: "A server error has occurred (audio)." },
});
}
}
