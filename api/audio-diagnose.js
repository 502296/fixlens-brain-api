// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
  runtime: "nodejs18.x",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const audioFile = files.audio?.[0];
    if (!audioFile) {
      return res.status(400).json({ error: "No audio uploaded" });
    }

    // 1️⃣ Transcribe audio
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: "gpt-4o-transcribe",
    });

    const text = transcription.text;

    // 2️⃣ Diagnose text
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
You are FixLens, a professional automotive AI.
User described this sound issue:
"${text}"

Respond naturally like ChatGPT.
No sections, no summaries.
Language: ${fields.preferredLanguage || "auto"}
      `,
    });

    const reply =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "I could not analyze the sound clearly.";

    res.status(200).json({ reply });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res.status(500).json({ error: "Audio diagnosis failed" });
  }
}
