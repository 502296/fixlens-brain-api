// api/audio-diagnose.js
// FixLens Sound Lab – Level 3 (Advanced car sound analysis)
// JSON body from Flutter (base64 audio)

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة تخمين اللغة اللي استخدمناها سابقاً
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

// نحول المايم تايب إلى format مقبول من gpt-audio
function mapMimeToFormat(mimeType) {
  const mt = (mimeType || "").toLowerCase();

  if (mt.includes("wav")) return "wav";
  if (mt.includes("mp3") || mt.includes("mpeg")) return "mp3";

  // ✅ IMPORTANT:
  // gpt-audio يقبل فقط: "wav" أو "mp3"
  // أي شيء آخر (m4a, webm, ...) نحوله إلى "mp3"
  return "mp3";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Flutter أحياناً يرسل body كسلسلة نصية
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // خليها فاضية لو فشل الـ JSON
        body = {};
      }
    }

    const audioBase64 = body?.audioBase64;
    const mimeType = body?.mimeType || "audio/m4a";
    const preferredLanguage = body?.language || "auto";

    if (!audioBase64) {
      return res.status(400).json({
        error: "No audioBase64 provided in request body",
      });
    }

    const format = mapMimeToFormat(mimeType);

    // 🧠 هنا السحر الحقيقي – gpt-audio
    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_AUDIO_MODEL || "gpt-audio",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "wav" }, // نطنّش الصوت الخارج حالياً
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

2. Perform a mechanic-style analysis:
   - Map patterns to: top-end / bottom-end engine, ignition/misfire,
     timing chain/belt, accessory belt/tensioner, exhaust leaks,
     wheel bearings, CV joints, suspension, brakes, drivetrain, mounts.

3. Return a list of most likely causes with approximate probabilities
   that roughly sum to 1.0.

4. Assess overall risk level (CRITICAL / HIGH / MEDIUM / LOW).

5. Give clear next steps for the driver.

LANGUAGE:
- If "preferredLanguage" is given (like "ar", "en", "es"), answer in it.
- If preferredLanguage = "auto", try to match the driver's spoken language.
- Tone: calm, friendly, confident – like an experienced mechanic
  explaining to a normal driver.

If the audio is mostly silence, strong wind noise, or human conversation
with no clear mechanical sound, say that you are **not confident** and
explain what kind of recording would help.
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
                data: audioBase64, // 👈 base64 من Flutter
                format,           // 👈 mp3 أو wav فقط
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
      source: "fixlens-audio",
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
}
