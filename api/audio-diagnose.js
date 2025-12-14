// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import path from "path";
import os from "os";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs",            // ✅
  api: { bodyParser: false },   // ✅
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function detectLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  return "en";
}

export default async function handler(req, res) {
  let tmpPath = null;

  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const contentType = String(req.headers["content-type"] || "").toLowerCase();

    let preferredLanguage = "auto";
    let extraText = "";
    let audioFilePath = null;

    // ✅ JSON base64 (Flutter عندك)
    if (contentType.includes("application/json")) {
      const body = await readJsonBody(req);

      preferredLanguage = String(body.language || body.preferredLanguage || "auto");
      extraText = String(body.message || body.text || body.note || "");
      const base64Audio = body.audioBase64 || body.audio || null;
      const mimeType = String(body.mimeType || "audio/m4a");

      if (!base64Audio) {
        return res.status(400).json({ error: "Missing audio base64. Send field: audioBase64" });
      }

      // نكتب الملف مؤقتاً بامتداد مناسب
      const ext =
        mimeType.includes("wav") ? "wav" :
        mimeType.includes("mp3") ? "mp3" :
        mimeType.includes("webm") ? "webm" :
        "m4a";

      tmpPath = path.join(os.tmpdir(), `fixlens_audio_${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, Buffer.from(base64Audio, "base64"));
      audioFilePath = tmpPath;
    }
    // ✅ multipart
    else if (contentType.includes("multipart/form-data")) {
      const { fields, files } = await parseForm(req);
      preferredLanguage = String(fields.preferredLanguage || fields.language || "auto");
      extraText = String(fields.message || fields.text || fields.note || "");

      const audioFile = files.audio;
      if (!audioFile) {
        return res.status(400).json({ error: "Missing audio file. Send multipart field: audio" });
      }
      audioFilePath = audioFile.filepath;
    } else {
      return res.status(415).json({ error: "Unsupported content-type. Use application/json or multipart/form-data." });
    }

    const lang = preferredLanguage === "auto"
      ? detectLanguage(extraText)
      : String(preferredLanguage);

    // ✅ 1) Transcribe
    let transcriptText = "";
    try {
      const transcript = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioFilePath),
        model: "gpt-4o-mini-transcribe",
      });
      transcriptText = String(transcript.text || "").trim();
    } catch (err) {
      console.error("Transcription error:", err);
      return res.status(500).json({
        error: "Audio diagnosis failed",
        details: "Transcription failed (possibly unsupported audio). Try a shorter recording or different format.",
      });
    }

    // ✅ 2) Match issues
    const combined = `${extraText}\n\nAUDIO TRANSCRIPT:\n${transcriptText}`.trim();
    const matchedIssues = findRelevantIssues(combined);

    // ✅ 3) Diagnose (chat.completions)
    const system = `
You are FixLens Auto — an expert mechanic-level diagnostic AI specialized in noises and symptoms.
Respond in: ${lang}
Use matched issues as hints only.
Output format:
🔧 Quick Summary
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
✅ Next Steps
⚠️ Safety Notes
`.trim();

    const user = `
User notes:
${extraText || "(none)"}

Audio transcript:
${transcriptText || "(empty transcript)"}

Matched issues (hints):
${JSON.stringify(matchedIssues, null, 2)}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.25,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "No reply.";
    return res.status(200).json({
      reply,
      transcript: transcriptText,
      matched_issues: matchedIssues,
      language: lang,
    });
  } catch (e) {
    console.error("Audio diagnose error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e?.message || String(e),
    });
  } finally {
    // تنظيف الملف المؤقت لو كتبناه
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}
