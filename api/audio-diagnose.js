// api/audio-diagnose.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import os from "os";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizeBase64(input) {
  if (!input) return null;
  let s = String(input);
  const idx = s.indexOf("base64,");
  if (idx !== -1) s = s.substring(idx + "base64,".length);
  s = s.trim();
  return s || null;
}

function extFromMime(mime = "") {
  const m = mime.toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("m4a")) return "m4a";
  if (m.includes("mp4")) return "mp4";
  if (m.includes("aac")) return "aac";
  return "m4a"; // default
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);

    const audioB64 = normalizeBase64(body.audioBase64 || body.audio);
    const mimeType = (body.mimeType || "audio/m4a").toString();
    const preferredLanguage = (body.language || "auto").toString();

    if (!audioB64) {
      return res.status(400).json({
        error: "Missing audio file. Send JSON field: audioBase64",
      });
    }

    // ✅ احفظ الصوت مؤقتاً في /tmp (Vercel يسمح)
    const ext = extFromMime(mimeType);
    const tmpPath = path.join(
      os.tmpdir(),
      `fixlens_audio_${Date.now()}.${ext}`
    );

    const buffer = Buffer.from(audioB64, "base64");
    fs.writeFileSync(tmpPath, buffer);

    // 1) Transcribe
    // NOTE: التحليل “من waveform فقط” غير مضمون. الأفضل transcription + أسئلة ذكية.
    const transcription = await client.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpPath),
    });

    const transcriptText =
      (transcription?.text || "").toString().trim() || "(no speech detected)";

    // 2) Diagnose from transcript
    const issues = findRelevantIssues(transcriptText);

    const prompt = `
You are FixLens Auto, an expert vehicle diagnostic AI.
User language: ${preferredLanguage} (if "auto", reply in the user's language).
We transcribed the user's voice note into text:

TRANSCRIPT:
${transcriptText}

Relevant automotive issues from internal database (may be empty):
${JSON.stringify(issues, null, 2)}

Return:
1) Quick Summary
2) Most likely causes (ranked)
3) Recommended next steps
4) Safety warnings (if any)
If transcript is unclear, ask 2-3 short follow-up questions.
`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt },
      ],
    });

    const reply = resp?.choices?.[0]?.message?.content || "No reply.";

    // تنظيف الملف المؤقت
    try {
      fs.unlinkSync(tmpPath);
    } catch {}

    return res.status(200).json({
      reply,
      language: preferredLanguage,
      transcript: transcriptText, // مفيد للتصحيح
    });
  } catch (e) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
