// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false }, // ✅ ضروري
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 15 * 1024 * 1024, // 15MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "").toString().trim() || null;
    const userNote = (fields.message || "").toString().trim(); // ملاحظة اختيارية من المستخدم

    // ✅ لازم اسم الحقل في Flutter يكون 'audio'
    const audioFile = files.audio;
    if (!audioFile) {
      return res.status(400).json({
        error: "Audio file is required",
        hint: "Send multipart/form-data with field name: audio",
      });
    }

    // 1) Transcribe
    const transcript = await openai.audio.transcriptions.create({
      model: process.env.FIXLENS_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      file: fs.createReadStream(audioFile.filepath),
    });

    const text = (transcript.text || "").trim();
    if (!text) {
      return res.status(400).json({
        error: "Transcription returned empty text",
      });
    }

    // 2) Diagnose using SAME prompt builder (AutoKnowledge included)
    const prompt = buildFixLensPrompt({
      userText: `Audio transcript: ${text}\nUser note: ${userNote || "N/A"}`,
      preferredLanguage,
      extraContext:
        "The user provided an audio recording from a vehicle. Infer likely issues from the transcript and note. Ask follow-up questions if needed.",
    });

    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_TEXT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const reply = completion.choices?.[0]?.message?.content || "";

    return res.status(200).json({
      reply,
      language: preferredLanguage,
      transcript: text, // ✅ مفيد للتجربة
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
