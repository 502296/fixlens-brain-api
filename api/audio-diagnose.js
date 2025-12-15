// api/audio-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { buildSystemPrompt } from "../lib/prompt.js";
import { parseMultipart, config as multipartConfig } from "./_multipart.js";

export const config = { ...multipartConfig, runtime: "nodejs18.x" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files, readFileBuffer } = await parseMultipart(req);

    const preferredLanguage = fields?.preferredLanguage || "auto";
    const message = (fields?.message || "").toString();

    const audioFile = files?.audio;
    if (!audioFile) return res.status(400).json({ error: "Audio file is required (field name: audio)" });

    const buf = readFileBuffer(audioFile);

    // ✅ تفريغ الصوت إلى نص (Transcription)
    const transcript = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: new File([buf], audioFile.originalFilename || "audio.m4a", {
        type: audioFile.mimetype || "audio/mp4",
      }),
    });

    const heardText = (transcript.text || "").trim();

    const combined = `
User notes (optional):
${message || "(none)"}

Transcribed audio:
${heardText || "(no transcript)"}
`.trim();

    const issues = findRelevantIssues(combined);

    const system = buildSystemPrompt(preferredLanguage);

    const out = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: system },
        {
          role: "user",
          content: `
Diagnose based on the audio transcription + notes.

${combined}

Relevant issues DB (if any):
${JSON.stringify(issues, null, 2)}
`.trim(),
        },
      ],
      temperature: 0.4,
    });

    const reply = (out.output_text || "").trim();
    return res.status(200).json({
      reply: reply || "No reply.",
      transcript: heardText,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
