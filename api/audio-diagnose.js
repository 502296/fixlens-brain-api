// api/audio-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs20.x",
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

    // Read raw binary audio
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const mimeType = req.headers["content-type"] || "audio/mpeg";
    const base64Audio = buffer.toString("base64");

    const ai = await client.responses.create({
      model: "gpt-5.1",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Analyze this engine sound. Identify the problem, causes, and recommended steps.",
            },
            {
              type: "input_file",
              mime_type: mimeType,
              data: base64Audio,
            },
          ],
        },
      ],
    });

    return res.status(200).json({
      reply: ai.output_text,
    });
  } catch (err) {
    console.error("AUDIO ERROR:", err);
    return res.status(500).json({
      error: "FixLens audio failed",
      details: err.message,
    });
  }
}
