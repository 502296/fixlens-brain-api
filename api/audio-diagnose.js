// api/audio-diagnose.js
import OpenAI from "openai";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import os from "os";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

function extFromMime(mime = "") {
  if (mime.includes("m4a")) return "m4a";
  if (mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  return "m4a";
}

export default async function handler(req, res) {
  let tmpFile = null;

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { audioBase64, mimeType, text, language } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== "string" || audioBase64.trim().length < 50) {
      return res.status(400).json({ error: "Missing audioBase64. Send JSON field: audioBase64" });
    }

    const detected = detectLanguage(text || "");
    const lang = (language && language !== "auto") ? language : detected;

    // Write to /tmp for transcription
    const ext = extFromMime(mimeType || "");
    const buf = Buffer.from(audioBase64, "base64");
    tmpFile = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
    await fsp.writeFile(tmpFile, buf);

    // 1) Transcribe
    const transcript = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: "gpt-4o-mini-transcribe"
    });

    const transcriptText = (transcript.text || "").trim();

    // 2) Match internal issues
    const combined = `${text || ""}\n\nAUDIO TRANSCRIPT:\n${transcriptText}`.trim();
    const matchedIssues = findRelevantIssues(combined);

    // 3) Diagnose
    const final = await client.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "system",
          content: `You are FixLens Auto, expert in diagnosing car noises & symptoms.
Respond in: ${lang}.
Format:
🔧 Quick Summary
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
⚠️ Safety Warnings
❌ What NOT to do
🧠 Pro Tip`
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: `User notes:\n${text || "(none)"}\n\nAudio transcript:\n${transcriptText || "(no transcript)"}\n\nMatched issues:\n${JSON.stringify(matchedIssues, null, 2)}` }
          ]
        }
      ],
      temperature: 0.3
    });

    const reply = (final.output_text || "").trim() || "No reply.";

    return res.status(200).json({
      reply,
      transcript: transcriptText,
      matched_issues: matchedIssues,
      language: lang
    });
  } catch (err) {
    console.error("Audio diagnose error:", err);
    return res.status(500).json({ error: "Audio diagnosis failed", details: err?.message || String(err) });
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  }
}
