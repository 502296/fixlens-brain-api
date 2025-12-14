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
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function pickFile(files, key) {
  const f = files?.[key];
  if (!f) return null;
  return Array.isArray(f) ? f[0] : f;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const userNotes = (fields.message || "").toString().trim();

    const audioFile = pickFile(files, "audio"); // ✅ لازم Flutter يرسل باسم audio
    if (!audioFile?.filepath) {
      return res.status(400).json({ error: "Missing audio file. Send multipart field: audio" });
    }

    // 1) Transcribe
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioFile.filepath),
      model: "gpt-4o-mini-transcribe",
    });

    const transcriptText = (transcript.text || "").trim();

    // 2) Match JSON using notes + transcript
    const combined = `${userNotes}\n\nAUDIO_TRANSCRIPT:\n${transcriptText}`.trim();
    const matched = findRelevantIssues(combined);

    // 3) Final diagnosis
    const final = await client.responses.create({
      model: "gpt-4o",
      temperature: 0.25,
      input: [
        {
          role: "system",
          content: `You are FixLens Auto — expert at diagnosing noises & symptoms.
Respond in user's language (${preferredLanguage}).
Use matched issues as hints, never claim certainty.
Format:
1) Quick Summary
2) Most Likely Causes (ranked)
3) Quick Tests
4) Recommended Next Steps
5) Safety Warnings`,
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
`User notes:
${userNotes || "(none)"}

Audio transcript:
${transcriptText || "(empty)"}

Matched issues (internal JSON):
${JSON.stringify(matched, null, 2)}`
            }
          ],
        },
      ],
    });

    const reply = (final.output_text || "").trim() || "No reply.";
    return res.status(200).json({
      reply,
      transcript: transcriptText,
      matched_issues: matched,
      language: preferredLanguage,
    });

  } catch (e) {
    console.error("Audio diagnose error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
