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
    const { image, text, language = "auto" } = req.body ?? {};

    if (!image) return res.status(400).json({ error: "No base64 image provided" });

    const visionInput = {
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "input_text", text: text ?? "" },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${image}`,
            },
          ],
        },
      ],
    };

    const response = await client.chat.completions.create(visionInput);

    return res.status(200).json({
      reply: response.choices[0].message.content,
      language,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err.message,
    });
  }
}
