// api/audio-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs18.x",
  bodyParser: false,
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    // Read the raw audio buffer
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Detect the audio type (fallback mp3)
    const mimeType =
      req.headers["content-type"] ||
      "audio/mpeg";

    // Convert to base64
    const base64Audio = buffer.toString("base64");

    // Send to GPT-5.1 / GPT-4o
    const ai = await client.responses.create({
      model: "gpt-4o", // ⬅️ أو gpt-5.1 لو تريد
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Analyze this engine sound precisely. Identify the problem, the most likely causes, and the recommended steps."
            },
            {
              type: "input_file",
              mime_type: mimeType,
              data: base64Audio
            }
          ]
        }
      ]
    });

    const reply =
      ai.output_text ||
      ai.response_text ||
      ai.output?.[0]?.content ||
      "No response generated.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({
      error: "FixLens audio failed",
      details: err.message,
    });
  }
}
