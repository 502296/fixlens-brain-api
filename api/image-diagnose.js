// api/image-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs20.x",
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    const { image, text = "" } = req.body ?? {};

    if (!image) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    const ai = await client.responses.create({
      model: "gpt-5.1",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text },
            {
              type: "input_file",
              mime_type: "image/jpeg",
              data: image,
            },
          ],
        },
      ],
    });

    return res.status(200).json({
      reply: ai.output_text,
    });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err.message,
    });
  }
}
