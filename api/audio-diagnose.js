// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "").toString() || null;
    const userNote = (fields.message || "").toString(); // ملاحظة اختيارية مع الصوت

    const audioFile = files.audio;
    if (!audioFile) return res.status(400).json({ error: "Audio file is required (field name: audio)" });

    // 1) Transcription
    const transcript = await openai.audio.transcriptions.create({
      model: process.env.FIXLENS_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      file: fs.createReadStream(audioFile.filepath),
    });

    const text = (transcript.text || "").trim();
    if (!text) return res.status(400).json({ error: "Transcription returned empty text" });

    // 2) Diagnose using SAME prompt + AutoKnowledge
    const prompt = buildFixLensPrompt({
      userText: `Audio transcript: ${text}\nUser note: ${userNote || "N/A"}`,
      preferredLanguage,
      extraContext: "The user provided an audio recording from a vehicle. Infer likely issues from described sound."
    });

    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_TEXT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt }
      ],
      temperature: 0.4,
    });

    const reply = completion.choices?.[0]?.message?.content || "";
    return res.status(200).json({
      reply,
      language: preferredLanguage,
      transcript: text, // مفيد للـ debugging داخل التطبيق
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
