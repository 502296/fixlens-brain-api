// api/audio-diagnose.js
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * OpenAI audio API ONLY accepts wav or mp3.
 * Flutter records m4a — so we MUST convert the format before sending.
 */
function mapMimeToFormat(mimeType) {
  const m = (mimeType || "").toLowerCase();

  if (m.includes("wav")) return "wav";
  if (m.includes("mp3") || m.includes("mpeg")) return "mp3";

  // Default fallback for m4a
  return "mp3";
}

export default async function handler(req, res) {
  try {
    const { audioBase64, mimeType, language = "auto" } = req.body;

    if (!audioBase64) {
      return res.status(400).json({ error: "No audioBase64 provided" });
    }

    const format = mapMimeToFormat(mimeType);

    // 🔥 نرسل الصوت بصيغة mp3 إلى OpenAI
    const response = await client.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text"],
      input_audio: [
        {
          data: audioBase64,
          format, // 👈 mp3 always
        },
      ],
      messages: [
        {
          role: "system",
          content: `You are FixLens Auto. Language: ${language}.`,
        },
        {
          role: "user",
          content: "Analyze this engine sound.",
        },
      ],
    });

    const reply =
      response.output_text ||
      response.choices?.[0]?.message?.content ||
      "Could not parse response.";

    return res.status(200).json({
      reply,
      language,
    });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    res
      .status(500)
      .json({ error: "Audio diagnosis failed", details: err.message });
  }
}
