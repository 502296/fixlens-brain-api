// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  const form = formidable({ multiples: false, maxFileSize: 30 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const extraText = (fields.message || "").toString();
    const audioFile = files.audio;

    if (!audioFile) {
      return res.status(400).json({ error: "Missing audio file. Send multipart field: audio" });
    }

    // 1) Transcribe audio -> text
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: "gpt-4o-mini-transcribe",
    });

    const transcriptText = (transcript.text || "").trim();

    // 2) Match internal JSON using message + transcript
    const combined = `${extraText}\n\nAUDIO TRANSCRIPT:\n${transcriptText}`.trim();
    const matchedIssues = findRelevantIssues(combined);

    // 3) Diagnose based on transcript + matches
    const final = await client.responses.create({
      model: "gpt-4.1",
      temperature: 0.25,
      input: [
        {
          role: "system",
          content: `You are FixLens Auto — expert at diagnosing vehicle noises and symptoms.
- Reply in the SAME language as the user (or ${preferredLanguage} if forced).
Format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
🛠 Recommended Fix
⚠️ Safety Warnings (only if needed)
If transcript is weak, ask up to 3 targeted questions.`,
        },
        {
          role: "user",
          content: `User notes:\n${extraText || "(none)"}\n\nAudio transcript:\n${transcriptText || "(no transcript)"}\n\nMatched issues:\n${JSON.stringify(matchedIssues, null, 2)}`,
        },
      ],
    });

    return res.status(200).json({
      reply: (final.output_text || "").trim() || "No reply.",
      transcript: transcriptText,
      matched_issues: matchedIssues,
      language: preferredLanguage,
    });
  } catch (e) {
    return res.status(500).json({ error: "Audio diagnosis failed", details: e?.message || String(e) });
  }
}
