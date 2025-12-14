import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const extraText = (fields.message || "").toString(); // optional
    const audioFile = files.audio; // Flutter لازم يرسل key اسمه "audio"

    if (!audioFile) {
      return res.status(400).json({ error: "Missing audio file. Send multipart field: audio" });
    }

    // 1) Transcribe (Whisper)
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: "gpt-4o-mini-transcribe",
    });

    const transcriptText = (transcript.text || "").trim();

    // 2) Match issues from JSON
    const combined = `${extraText}\n\nAUDIO TRANSCRIPT:\n${transcriptText}`.trim();
    const matchedIssues = findRelevantIssues(combined);

    // 3) Diagnose
    const final = await client.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "system",
          content: `You are FixLens Auto, expert in diagnosing car noises & symptoms.
Respond in user's language: ${preferredLanguage}.
Use the matched issues as hints. Provide: Quick Summary, Likely Causes, Tests user can do, Safety warnings.`,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: `User notes:\n${extraText || "(none)"}\n\nAudio transcript:\n${transcriptText || "(no transcript)"}\n\nMatched issues:\n${JSON.stringify(matchedIssues, null, 2)}` },
          ],
        },
      ],
    });

    return res.status(200).json({
      reply: final.output_text?.trim() || "No reply.",
      transcript: transcriptText,
      matched_issues: matchedIssues,
      language: preferredLanguage,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
