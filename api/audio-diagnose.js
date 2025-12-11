// api/audio-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs20.x",
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const { audioBase64, language = "auto" } = req.body ?? {};

    if (!audioBase64)
      return res.status(400).json({ error: "No audioBase64 provided" });

    // Always treat as mp3 (FixLens app converts automatically)
    const audioBuffer = Buffer.from(audioBase64, "base64");

    const result = await client.chat.completions.create({
      model: "gpt-4o-audio-preview",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", audio: audioBuffer },
            {
              type: "input_text",
              text: `
Analyze this engine or vehicle sound.
Detect mechanical issues, possible causes, severity and next steps.
Language: ${language}
              `
            }
          ]
        }
      ]
    });

    return res.status(200).json({
      reply: result.choices[0].message.content,
      language,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err.message,
    });
  }
}
