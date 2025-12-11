// api/audio-diagnose.js
// FixLens Sound Lab – Robust audio pipeline
// 1) Transcribe audio with gpt-4o-mini-transcribe
// 2) Diagnose using GPT-5.1-mini with a sound-focused system prompt

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false, // مهم حتى نستخدم formidable
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper: guess language from text
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Russian
  if (/[áéíóúñüÁÉÍÓÚÑÜ]/.test(t)) return "es"; // Spanish-ish
  if (/[äöüßÄÖÜ]/.test(t)) return "de"; // German-ish
  if (/[àâçéèêëîïôûùüÿÀÂÇÉÈÊËÎÏÔÛÙÜŸ]/.test(t)) return "fr"; // French-ish

  return "en";
}

function cleanText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

// محاولة معرفة نوع الملف الصوتي (للمعلومات فقط)
function detectAudioFormat(audioFile) {
  const mime = (audioFile.mimetype || "").toLowerCase();
  const name = (audioFile.originalFilename || audioFile.newFilename || "").toLowerCase();

  if (mime.includes("wav") || name.endsWith(".wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3") || name.endsWith(".mp3")) return "mp3";
  if (mime.includes("m4a") || name.endsWith(".m4a")) return "m4a";
  if (mime.includes("webm") || name.endsWith(".webm")) return "webm";

  // Flutter record عادة يطلع m4a
  return "m4a";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = formidable({ multiples: false });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("Form parse error (audio):", err);
        return res.status(400).json({ error: "Invalid form data" });
      }

      const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;

      if (!audioFile) {
        return res.status(400).json({ error: "No audio file provided" });
      }

      const preferredLanguageField =
        (Array.isArray(fields.preferredLanguage)
          ? fields.preferredLanguage[0]
          : fields.preferredLanguage) ||
        (Array.isArray(fields.language) ? fields.language[0] : fields.language) ||
        (Array.isArray(fields.lang) ? fields.lang[0] : fields.lang) ||
        req.query.preferredLanguage ||
        "auto";

      const filePath = audioFile.filepath || audioFile.path;
      const format = detectAudioFormat(audioFile);

      // 1) Transcribe with gpt-4o-mini-transcribe
      let transcriptText = "";
      try {
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model: "gpt-4o-mini-transcribe",
          // نعطيه لغة تقريبية لو حاب (اختياري)
          language:
            preferredLanguageField && preferredLanguageField !== "auto"
              ? preferredLanguageField
              : undefined,
          response_format: "json",
        });

        transcriptText = cleanText(transcription.text);

        if (!transcriptText) {
          // لا يوجد كلام واضح في التسجيل
          return res.status(200).json({
            reply:
              "FixLens Sound Lab could not clearly detect speech or a consistent mechanical pattern in this recording. Please try again, hold the phone closer to the sound source, and record at least 10–15 seconds.",
            language:
              preferredLanguageField && preferredLanguageField !== "auto"
                ? preferredLanguageField
                : "en",
          });
        }
      } catch (readErr) {
        console.error("Error transcribing audio file:", readErr);
        return res.status(500).json({
          error: "Audio diagnosis failed",
          details: "Could not transcribe audio on server",
        });
      }

      // 2) Diagnose using GPT-5.1-mini with a sound-focused prompt
      try {
        const resolvedLanguage =
          (preferredLanguageField && preferredLanguageField !== "auto" && preferredLanguageField) ||
          guessLanguage(transcriptText) ||
          "en";

        const systemPrompt = `
You are **FixLens Auto – Sound Lab**, a careful AI mechanic that analyzes car problems
based on what the driver recorded and what was transcribed from the audio.

The transcription below may include:
- Driver's spoken description of the sound.
- Descriptive words about the noise (knock, ping, squeal, grinding, etc.).
- Any context about speed, RPM, braking, turning, etc.

Your job:
1. Extract all details related to the sound pattern and when it happens.
2. Map those patterns to mechanical causes:
   - engine top-end (lifters/valvetrain)
   - engine bottom-end (rods/bearings)
   - ignition/misfire
   - timing chain/belt
   - accessory belt/tensioner/pulleys
   - exhaust leaks / rattling shields
   - wheel bearings, CV joints, suspension
   - brakes (pads, rotors, calipers)
   - drivetrain and mounts
3. Provide a ranked list of likely causes with approximate probabilities.
4. Assess risk:
   - CRITICAL – Stop driving immediately.
   - HIGH – Drive only gently and visit a mechanic ASAP.
   - MEDIUM – Schedule a shop visit soon.
   - LOW – Probably minor, but worth checking.

LANGUAGE:
- The driver's language code is: "${resolvedLanguage}".
- ALWAYS reply in this language only.
- Use a calm, friendly tone like an experienced mechanic talking to a normal driver.

If the transcription is mostly unrelated conversation and no clear car sound context,
say that you are not confident and explain what kind of recording would help.
        `.trim();

        const combinedPrompt = `
System instructions:
${systemPrompt}

Transcribed audio from the driver:
${transcriptText}
        `.trim();

        const response = await openai.responses.create({
          model: "gpt-5.1-mini",
          input: combinedPrompt,
          max_output_tokens: 900,
        });

        const replyText = cleanText(response.output_text);

        return res.status(200).json({
          reply:
            replyText ||
            "FixLens Sound Lab could not confidently diagnose from this recording. Please try again with a clearer sample focusing on the car sound.",
          language: resolvedLanguage,
          format,
        });
      } catch (apiError) {
        console.error("FixLens Sound Lab analysis error:", apiError);
        return res.status(500).json({
          error: "Audio diagnosis failed",
          details:
            apiError?.response?.data ||
            apiError.message ||
            String(apiError),
        });
      }
    });
  } catch (e) {
    console.error("Unexpected audio handler error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message || String(e),
    });
  }
}
