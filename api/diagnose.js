// api/audio-diagnose.js
// FixLens Sound Lab – JSON base64 version (no multipart)

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة تخمين اللغة
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

function detectFormatFromMime(mimeType) {
  const mt = (mimeType || "").toLowerCase();
  if (mt.includes("wav")) return "wav";
  if (mt.includes("mpeg") || mt.includes("mp3")) return "mp3";
  if (mt.includes("m4a") || mt.includes("aac")) return "m4a";
  if (mt.includes("webm")) return "webm";
  // Flutter record غالباً m4a
  return "m4a";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Vercel يمرّر body جاهز كـ JSON
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // نخليها كما هي لو ما قدر يفسّرها
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

    const format = detectFormatFromMime(mimeType);

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.FIXLENS_AUDIO_MODEL || "gpt-audio",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" }, // نقدر نطنش الصوت الراجع حالياً
        messages: [
          {
            role: "system",
            content: `
You are **FixLens Auto – Sound Lab v3**, a world-class AI mechanic
specialized in diagnosing car problems *purely from sound*.

(نفس البرومبت الطويل اللي كتبناه سابقاً، يفسّر كيفية تحليل الصوت، 
احفظه كما هو عندك أو اختصره لو تحب.)
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
                  data: audioBase64, // 👈 base64 مباشرة من Flutter
                  format,            // wav / mp3 / m4a / webm
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
  } catch (e) {
    console.error("Unexpected audio handler error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message || String(e),
    });
  }
}
