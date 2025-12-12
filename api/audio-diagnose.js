// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false }, // 👈 ضروري للـ multipart
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  if (/[áéíóúñ¿¡]/i.test(t)) return "es";
  return "en";
}

function parseForm(req) {
  const form = formidable({ multiples: false });
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
    const preferredLanguage = fields?.preferredLanguage?.toString();
    const audioFile = files?.audio;

    if (!audioFile) {
      return res.status(400).json({ error: "Audio file is required (field name: audio)" });
    }

    const filePath = audioFile.filepath || audioFile.path;
    const stream = fs.createReadStream(filePath);

    // 1) ✅ Transcribe audio → text
    const tr = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: stream,
    });

    const transcript = (tr.text || "").trim();
    if (!transcript) {
      return res.status(400).json({ error: "Could not transcribe audio (empty transcript)" });
    }

    // 2) ✅ Diagnose transcript like normal text
    const issues = findRelevantIssues(transcript);
    const detected = guessLanguage(transcript);
    const lang = preferredLanguage || detected || "auto";

    const prompt = `
You are FixLens Auto, the world’s smartest vehicle diagnostic AI.

User language: ${lang}
User provided AUDIO. Transcript:
${transcript}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in the user's language (or auto-detect).
Format exactly:
1) Quick Summary
2) Most likely causes (ranked)
3) Recommended next steps
4) Safety warnings
`;

    const response = await client.responses.create({
      model: "gpt-5.2",
      input: prompt,
    });

    return res.status(200).json({
      reply: response.output_text || "",
      transcript,
      language: lang,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
