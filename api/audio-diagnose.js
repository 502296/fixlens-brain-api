// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  api: { bodyParser: false }, // ✅ مهم
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

    const preferredLanguage =
      (fields.preferredLanguage || "").toString().trim() || null;

    const userNote = (fields.message || "").toString().trim();

    const audioFile = files.audio;
    if (!audioFile) {
      return res.status(400).json({
        error: "Audio file is required",
        hint: "Send multipart/form-data with field name: audio",
      });
    }

    // 🔊 1) Transcription
    const transcript = await openai.audio.transcriptions.create({
      model:
        process.env.FIXLENS_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      file: fs.createReadStream(audioFile.filepath),
    });

    const text = (transcript.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Empty transcription result" });
    }

    // 🧠 2) Diagnose using same AutoKnowledge pipeline
    const prompt = buildFixLensPrompt({
      userText: `Audio transcript: ${text}\nUser note: ${
        userNote || "N/A"
      }`,
      preferredLanguage,
      extraContext:
        "The user provided a vehicle sound recording. Infer likely causes from the described sound.",
    });

    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_TEXT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    return res.status(200).json({
      reply: completion.choices?.[0]?.message?.content || "",
      language: preferredLanguage,
      transcript: text,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
