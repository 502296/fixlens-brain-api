// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function pickFile(files) {
  // formidable أحياناً يرجع Array
  const f =
    files?.audio ||
    files?.file ||
    files?.audioFile;

  if (!f) return null;
  return Array.isArray(f) ? f[0] : f;
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
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields?.preferredLanguage || fields?.lang || "").toString();
    const audioFile = pickFile(files);

    if (!audioFile) {
      return res.status(400).json({
        error: "Audio file is required (field name: audio)",
        hint: "Send multipart with field name 'audio' (or file/audioFile).",
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
    if (!transcript) return res.status(400).json({ error: "Empty transcript" });

    // 2) Diagnose transcript (بنفس ستايل الورشة)
    const lang = preferredLanguage || "auto";

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content:
            "You are FixLens Auto — speak like a real workshop technician. Be concise. Reply in the user's language.",
        },
        {
          role: "user",
          content: `User language: ${lang}\nTranscript:\n${transcript}\n\nFormat:\n🔧 Quick Diagnosis\n⚡ Most Likely Causes (ranked)\n🧪 Quick Tests\n❌ What NOT to do\n🧠 Pro Tip\n`,
        },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";

    return res.status(200).json({ reply, transcript, language: lang });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({ error: "Audio diagnosis failed", details: err?.message || String(err) });
  }
}
