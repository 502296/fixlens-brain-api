// api/audio-diagnose.js
import OpenAI, { toFile } from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// LANGUAGE GUESS
function guessLanguage(text) {
  if (!text || !text.trim()) return "en";
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  return "en";
}

// SYSTEM PROMPT
const SYSTEM_PROMPT = `
You are FixLens Auto, an intelligent vehicle diagnostics assistant.
You ONLY diagnose sounds from vehicles and NEVER talk about anything else.

You will receive:
- An audio FILE of the sound (engine knock, tick, squeal, etc.)
- A short Whisper transcription (if any speech exists)
- Optional notes
- Auto-knowledge-base matched issues

Your job:
1. LISTEN to the audio carefully.
2. Identify the sound pattern (knock, tick, squeal, grind, etc.)
3. Combine with transcription + notes + KB
4. Produce structured diagnosis.

Reply ONLY in the user's language.

Format:
**Quick Summary:**
**What the Sound Feels Like:**
**Most Likely Causes:**
**Recommended Checks:**
**Safety Notes:**
**Next Step:**
`;

// Helper extract text
function extractText(resp) {
  try {
    const first = resp.output?.[0];
    const textPart = first?.content?.find(
      (c) => c.type === "output_text"
    );
    return textPart?.text || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body || {};

    const {
      audioBase64,
      mimeType = "audio/m4a",
      language: clientLang,
      note
    } = body;

    if (!audioBase64)
      return res.status(400).json({ error: "Missing audioBase64" });

    // Convert base64 → file
    const audioBuffer = Buffer.from(audioBase64, "base64");

    const audioFile = await toFile(
      audioBuffer,
      "sound.m4a",
      { type: mimeType }
    );

    // Whisper transcription
    const whisper = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: audioFile,
    });

    const transcript = (whisper.text || "").trim();
    const lang = clientLang && clientLang !== "auto"
      ? clientLang
      : guessLanguage(transcript || note);

    // Knowledge base results
    let issues = [];
    try {
      issues = await findRelevantIssues(transcript || note || "");
    } catch {}

    // Build user prompt
    const userBundle = `
User transcription:
"${transcript || "N/A"}"

User note:
"${note || "N/A"}"

Matched issues:
${JSON.stringify(issues, null, 2)}

User language: ${lang}
`;

    // 🔥 THE MAGIC: SEND AUDIO AS input_file (SUPPORTED)
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }]
        },
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: audioFile.id, // <-- THIS WORKS
            },
            {
              type: "input_text",
              text: userBundle
            }
          ]
        }
      ]
    });

    let reply = extractText(resp);

    if (!reply)
      reply =
        lang === "ar"
          ? "لم أستطع تحليل الصوت، الرجاء إعادة التسجيل في مكان هادئ."
          : "I couldn’t analyze the sound, please record again in a quieter environment.";

    return res.status(200).json({
      reply,
      language: lang,
      transcript,
      issues,
      source: "fixlens-audio",
    });

  } catch (err) {
    console.error("Audio error:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message || err,
    });
  }
}
