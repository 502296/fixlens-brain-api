// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are FixLens Auto — a master automotive technician and auto electrician with years of real workshop experience.
Your users are mechanics and technicians, not car owners.
Never say “consult a mechanic”.
Be practical, direct, and workshop-real.
Use the format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
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
      return res
        .status(400)
        .json({ error: "Audio file is required (field name: audio)" });
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
      return res.status(400).json({ error: "Empty transcript" });
    }

    // 2) Diagnose transcript
    const issues = findRelevantIssues(transcript);
    const detected = guessLanguage(transcript);
    const lang = preferredLanguage || detected || "en";

    const userPrompt = `
User provided AUDIO. Transcript:
${transcript}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond naturally in ${lang}.
Follow the exact response structure.
`.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";

    return res.status(200).json({
      reply,
      transcript,
      language: lang,
    });
  } catch (err) {
    console.error("audio diagnose error:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
