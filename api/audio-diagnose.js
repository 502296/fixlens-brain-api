// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `
You are FixLens Auto — a master automotive technician and auto electrician.
Users are mechanics/technicians.
Be direct and practical.

Use this structure:
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
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
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
    const audioFile = files?.audio; // لازم Flutter يرسل field اسمه audio

    if (!audioFile) {
      return res.status(400).json({
        error: "Audio file is required (field name: audio)",
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
      return res.status(400).json({ error: "Empty transcript" });
    }

    // 2) Diagnose transcript
    const issues = findRelevantIssues(transcript);
    const detected = guessLanguage(transcript);
    const lang = preferredLanguage || detected || "en";

    const userPrompt = `
User sent AUDIO. Transcript:
${transcript}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in (${lang}) naturally.
Follow the structure exactly.
Assume user is a mechanic.
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
      details: String(err?.message || err),
    });
  }
}
