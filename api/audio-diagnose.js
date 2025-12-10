// api/audio-diagnose.js
// FixLens Sound Lab – Level 3 (Advanced car sound analysis)
// Uses gpt-audio with Chat Completions API

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

// نفس دالة تخمين اللغة اللي نستخدمها في باقي ملفات FixLens
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

// محاولة معرفة نوع الملف الصوتي
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

      const preferredLanguage =
        (Array.isArray(fields.preferredLanguage)
          ? fields.preferredLanguage[0]
          : fields.preferredLanguage) ||
        req.query.preferredLanguage ||
        "auto";

      const filePath = audioFile.filepath || audioFile.path;
      const format = detectAudioFormat(audioFile);

      let base64Audio;
      try {
        const buffer = fs.readFileSync(filePath);
        base64Audio = buffer.toString("base64");
      } catch (readErr) {
        console.error("Error reading audio file:", readErr);
        return res.status(500).json({
          error: "Audio diagnosis failed",
          details: "Could not read audio file on server",
        });
      }

      try {
        // ⚡ هنا السحر الحقيقي – gpt-audio
        // نستخدم Chat Completions + input_audio
        const completion = await openai.chat.completions.create({
          model: process.env.FIXLENS_AUDIO_MODEL || "gpt-audio",
          // نسمح للنموذج يرجع نص فقط (نطنش الصوت الخارج)
          modalities: ["text", "audio"], // نخلي audio مفعّل لو احتجناه مستقبلاً
          audio: { voice: "alloy", format: "wav" }, // نقدر نتجاهل الـ output audio حالياً
          messages: [
            {
              role: "system",
              content: `
You are **FixLens Auto – Sound Lab v3**, a world-class AI mechanic
specialized in diagnosing car problems *purely from sound*.

You receive a recording from somewhere in or around a vehicle:
engine bay, exhaust, suspension, brakes, steering, or cabin.

Analyze the **waveform itself**, not just speech:

1. Decompose the sound:
   - Identify main patterns: knocking, pinging, tapping, ticking,
     squeaking, chirping, grinding, whining, humming, rattling, hissing,
     whooshing, rumbling, belt slapping, metallic clunking, etc.
   - Notice if the sound follows engine RPM, road speed, bumps, braking,
     turning the steering wheel, or gear shifts.

2. Perform a mental "mechanic-style" analysis:
   - For each sound pattern, map it to mechanical sources:
     * top-end engine (lifters, valve train),
     * bottom-end engine (rods, bearings),
     * ignition / misfire,
     * timing chain / belt,
     * accessory belt / tensioner / pulleys,
     * exhaust leaks or rattling heat shields,
     * wheel bearings, CV joints, suspension,
     * brakes (pads, rotors, calipers),
     * drivetrain and transmission mounts.

3. Produce a list of **most likely causes** with approximate probabilities:
   - Example:
     - 0.72 – Failing rod bearing (deep knock following RPM)
     - 0.31 – Loose heat shield (metallic rattle on bumps, not with RPM)
   - The probabilities should roughly sum to 1.0, but they are estimates.

4. For each cause, describe:
   - Which component is likely affected.
   - Why the sound's frequency, rhythm, and behavior match that issue.
   - Whether the issue tends to be common or rare.

5. Assess **overall risk level**:
   - CRITICAL – Stop driving immediately (risk of catastrophic damage).
   - HIGH – Avoid highway / hard acceleration, see mechanic ASAP.
   - MEDIUM – Schedule a shop visit soon, avoid stressing the system.
   - LOW – Monitor; likely minor or early stage, but still worth checking.

6. Provide **clear next steps for the driver**:
   - What to tell the mechanic about the sound and when it appears.
   - Any simple safe checks the driver can do (checking oil level,
     visually checking belts, looking for leaks, etc.).
   - When it's absolutely unsafe to keep driving.

LANGUAGE:
- If "preferredLanguage" is given, answer in that language (short code like "ar", "en", "es").
- If preferredLanguage = "auto", try to match the driver's spoken language if you detect speech.
- Keep the tone calm, friendly, and confident – like a smart, experienced mechanic
  explaining the situation to a normal driver.

If the audio is mostly silence, strong wind noise, or human conversation
with no clear mechanical sound, say that you are **not confident** and
explain what kind of recording would help (where to hold the phone,
how long to record, etc.).
            `.trim(),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    preferredLanguage && preferredLanguage !== "auto"
                      ? `This is a car sound recording. Analyze ONLY the mechanical sound and answer in language code: ${preferredLanguage}.`
                      : `This is a car sound recording from a vehicle. Analyze ONLY the mechanical sound (not my words) and reply in the same language as the driver if possible.`,
                },
                {
                  type: "input_audio",
                  input_audio: {
                    data: base64Audio,
                    format,
                  },
                },
              ],
            },
          ],
        });

        const choice = completion.choices[0];
        let replyText = "";

        if (typeof choice.message.content === "string") {
          replyText = choice.message.content;
        } else if (Array.isArray(choice.message.content)) {
          const textPart = choice.message.content.find((p) => p.type === "text");
          replyText = textPart?.text || JSON.stringify(choice.message.content);
        } else {
          replyText = JSON.stringify(choice.message);
        }

        const detectedLang = guessLanguage(replyText);
        const finalLang =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage
            : detectedLang || "en";

        return res.status(200).json({
          reply: replyText,
          language: finalLang,
        });
      } catch (apiError) {
        console.error("FixLens Sound Lab (gpt-audio) error:", apiError);
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
