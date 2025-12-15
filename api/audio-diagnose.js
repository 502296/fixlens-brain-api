// api/audio-diagnose.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";

import { readJsonBody, safeBase64ToBuffer, extFromMime } from "./_utils.js";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  let tmpPath = null;

  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);
    if (!body) {
      return res.status(400).json({ error: "Missing JSON body" });
    }

    const { audioBase64, mimeType, language } = body;

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({
        error: "Missing audio file",
        details: "Send JSON field: audioBase64",
      });
    }

    const buf = safeBase64ToBuffer(audioBase64);
    if (!buf || !buf.length) {
      return res.status(400).json({
        error: "Invalid audioBase64",
      });
    }

    const ext = extFromMime(mimeType);
    tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpPath, buf);

    // 1) Speech → Text
    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: "gpt-4o-mini-transcribe",
    });

    const transcriptText =
      (transcript?.text || "").toString().trim();

    if (!transcriptText) {
      return res.status(400).json({
        error: "Audio transcription empty",
      });
    }

    // 2) Diagnose from transcript
    const issues = findRelevantIssues(transcriptText);

    const prompt = `
You are FixLens Auto, the world-class vehicle diagnostic AI.
User language: ${language || "auto"}.
If "auto", detect from transcript language.

Audio transcript:
${transcriptText}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Respond in user's language.
Provide:
1) Quick Summary
2) Most likely causes
3) Recommended next steps
4) Safety warnings
`;

    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: prompt,
    });

    return res.status(200).json({
      reply: ai.output_text,
      transcript: transcriptText,
      language: language || "auto",
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || String(err),
    });
  } finally {
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}
