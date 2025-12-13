// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are FixLens Auto — a master automotive technician and auto electrician.
Users are mechanics. Be direct and practical.
Format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

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
    const preferredLanguage = fields?.preferredLanguage?.toString() || "";
    const audioFile = files?.audio;

    if (!audioFile) {
      return res.status(400).json({ error: "Audio file is required (field name: audio)" });
    }

    const filePath = audioFile.filepath || audioFile.path;
    const stream = fs.createReadStream(filePath);

    // 1) Transcribe
    const tr = await openai.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: stream,
    });

    const transcript = (tr.text || "").trim();
    if (!transcript) {
      return res.status(400).json({ error: "Empty transcript" });
    }

    // 2) Diagnose transcript (مثل text)
    const issues = findRelevantIssues(transcript);

    const userPrompt = `
User AUDIO transcript:
${transcript}

Relevant issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in user's language naturally (${preferredLanguage || "auto"}).
Follow the format exactly.
`.trim();

    const completion = await openai.chat.completions.create({
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
      language: preferredLanguage || "auto",
    });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
