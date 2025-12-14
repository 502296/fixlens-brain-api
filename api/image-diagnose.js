// api/image-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { image, text } = req.body;

    if (!image) {
      return res.status(400).json({ error: "Image base64 is required" });
    }

    const prompt = `
You are FixLens Auto, an expert automotive diagnostic AI.
Analyze the image carefully and respond professionally.

User message:
${text || "No text provided"}

Provide:
1. Quick summary
2. Possible visible issues
3. What cannot be determined from the image
4. Next recommended steps
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${image}`,
              },
            },
          ],
        },
      ],
    });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "No response generated.";

    res.status(200).json({ reply });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({
      error: "Image diagnosis failed",
      details: err.message,
    });
  }
}
