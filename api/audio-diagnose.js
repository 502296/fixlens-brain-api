// api/audio-diagnose.js
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =============== Fix: Force audio to be treated as mp3 ===============
function forceFormatToMp3() {
  return "mp3";
}
// ====================================================================

export default async function handler(req, res) {
  try {
    const { audioBase64, mimeType, language = "auto" } = req.body || {};

    if (!audioBase64) {
      return res.status(400).json({ error: "Missing audioBase64" });
    }

    // نخبر GPT أن الملف mp3 حتى لو كان M4A
    const audioFormat = forceFormatToMp3();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      messages: [
        {
          role: "system",
          content:
            "You are FixLens Auto. You listen to engine sounds and diagnose issues.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Analyze this engine sound. Describe the noise and give likely causes.",
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: audioFormat, // ← هنا الحل 🔥
              },
            },
          ],
        },
      ],
    });

    const reply = completion.choices[0]?.message?.content ?? "";

    return res.status(200).json({
      reply,
      language,
    });
  } catch (err) {
    console.error("Audio diagnose error:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message,
    });
  }
}
