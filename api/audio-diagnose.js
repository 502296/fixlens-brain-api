// api/audio-diagnose.js
import OpenAI, { toFile } from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function guessLanguage(t) {
  if (!t) return "en";
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  return "en";
}

const SYSTEM_PROMPT = `
You are FixLens Auto, an intelligent automotive sound-diagnosis system.
Analyze the audio carefully: clicking, knocking, rattling, squealing, grinding, misfire patterns.
Reply ONLY in the user's language with structured output.
`;

function extractText(resp) {
  try {
    const part = resp.output?.[0]?.content?.find((c) => c.type === "output_text");
    return part?.text || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ error: "POST only" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { audioBase64, mimeType = "audio/m4a", note, language } = body;

    if (!audioBase64)
      return res.status(400).json({ error: "Missing audioBase64" });

    // Convert base64 → Buffer
    const audioBuffer = Buffer.from(audioBase64, "base64");

    // Convert to File (required by API)
    const localFile = await toFile(audioBuffer, "sound.m4a", { type: mimeType });

    // ---- STEP 1: Upload file to OpenAI ----
    const uploaded = await openai.files.create({
      file: localFile,
      purpose: "input",
    });

    const fileId = uploaded.id; // REAL ID 🎯

    // ---- STEP 2: Whisper Transcription ----
    const whisper = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: localFile,
    });

    const transcript = whisper.text?.trim() || "";
    const lang = language && language !== "auto"
      ? language
      : guessLanguage(transcript || note);

    const kb = await findRelevantIssues(transcript || note || "");

    const userBundle = `
Transcription: "${transcript || "N/A"}"
Note: "${note || "N/A"}"
Matched issues: ${JSON.stringify(kb, null, 2)}
Language: ${lang}
    `;

    // ---- STEP 3: GPT DIAGNOSIS REQUEST ----
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [
            { type: "input_file", file_id: fileId }, // ✅ CORRECT
            { type: "input_text", text: userBundle },
          ],
        },
      ],
    });

    let reply = extractText(resp);
    if (!reply) reply = "Could not analyze audio.";

    return res.status(200).json({
      reply,
      transcript,
      issues: kb,
      language: lang,
    });

  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.response?.data || err?.message || err,
    });
  }
}
