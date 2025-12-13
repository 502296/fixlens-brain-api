// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

function parseForm(req) {
  const form = formidable({ multiples: false, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields?.preferredLanguage || "").toString().trim();

    // يقبل أكثر من اسم للحقل
    const audioFile =
      files?.audio ||
      files?.file ||
      files?.audioFile ||
      files?.voice;

    if (!audioFile) {
      return res.status(400).json({
        error: "Audio file is required (field name: audio)",
        hint: "Send multipart with field name 'audio' (or file/audioFile).",
      });
    }

    const filePath = audioFile.filepath || audioFile.path;
    const stream = fs.createReadStream(filePath);

    // 1) Transcribe
    const tr = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: stream,
    });

    const transcript = (tr.text || "").trim();
    if (!transcript) {
      return res.status(400).json({ error: "Could not transcribe audio (empty transcript)" });
    }

    const lang = preferredLanguage || detectLanguage(transcript);

    // 2) Diagnose transcript
    const system = `
You are FixLens Auto — expert automotive technician.
Reply in: ${lang}.
Be concise and practical.
Format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.25,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `Audio transcript:\n${transcript}` },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";

    return res.status(200).json({
      reply,
      transcript,
      language: lang,
    });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
