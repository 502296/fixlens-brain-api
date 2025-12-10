// api/audio-diagnose.js
// FixLens Sound Lab – Level 3 (car sound analysis)

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة التخمين المستخدمة في ملفاتك الأخرى
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

// محاولة تخمين فورمات الصوت من المايم تايب أو الاسم
function detectAudioFormat(audioFile) {
  const mime = (audioFile.mimetype || "").toLowerCase();
  const name = (audioFile.originalFilename || audioFile.newFilename || "").toLowerCase();

  if (mime.includes("wav") || name.endsWith(".wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3") || name.endsWith(".mp3")) return "mp3";
  if (mime.includes("m4a") || name.endsWith(".m4a")) return "m4a";
  if (mime.includes("webm") || name.endsWith(".webm")) return "webm";

  // Flutter record غالباً ينتج m4a
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

      const audioFile = Array.isArray(files.audio)
        ? files.audio[0]
        : files.audio;

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
        // ⚠️ هنا نستخدم Chat Completions مع gpt-4o-audio-preview
        const completion = await openai.chat.completions.create({
          model: process.env.FIXLENS_AUDIO_MODEL || "gpt-4o-audio-preview",
          // نريد فقط نص (ما نحتاج صوت كإخراج)
          modalities: ["text"],
          messages: [
            {
              role: "system",
              content: `
You are FixLens Auto – Sound Lab, a world-class AI mechanic that specializes
in understanding car problems *from the sound alone*.

You are given a recording of a car sound (engine, exhaust, suspension, brakes, etc).
There may be some voice in the background, but your main focus is the mechanical sound itself.

Your job:

1. Identify the *type of sound*:
   - knocking, ticking, tapping, squeaking, chirping, grinding, whining, humming, hissing, whooshing, rattling, etc.
2. List the *most likely mechanical causes*, with an approximate probability percentage for each.
3. For each cause, describe:
   - what part is likely affected,
   - why this sound matches that problem.
4. Provide an *overall risk level*:
   - CRITICAL – stop driving immediately,
   - HIGH – check as soon as possible,
   - MEDIUM – schedule a visit soon,
   - LOW – monitor, but not urgent.
5. Give clear, simple *next steps for the driver*:
   - what to tell the mechanic,
   - what to avoid (e.g., high RPM, highway speeds),
   - any quick checks that can be done safely.

LANGUAGE:
- If "preferredLanguage" is provided, respond in that language (short code, e.g. "ar", "en", "es").
- If preferredLanguage = "auto", respond in the same language as the driver's speech if possible.
- Keep the style friendly, calm, and confident – like a smart mechanic explaining to a normal driver.

IMPORTANT:
- If the audio quality is too poor or mostly silence, say clearly that you are not confident,
  and explain what kind of recording would help more next time.
            `.trim(),
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    preferredLanguage && preferredLanguage !== "auto"
                      ? `This is a car sound recording. Analyze ONLY the sound and answer in language code: ${preferredLanguage}.`
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
          const textPart = choice.message.content.find(
            (p) => p.type === "text"
          );
          replyText =
            textPart?.text || JSON.stringify(choice.message.content);
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
        console.error("FixLens Sound Lab (audio) error:", apiError);
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
