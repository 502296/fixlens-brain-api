// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
  runtime: "nodejs18.x",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const form = formidable();
    const { files, fields } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const imageFile = files.image?.[0];
    if (!imageFile) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const imageBuffer = fs.readFileSync(imageFile.filepath);
    const base64Image = imageBuffer.toString("base64");

    const prompt = `
You are FixLens, a world-class automotive diagnostic AI.
Analyze the image of the vehicle or engine bay.
Respond naturally like ChatGPT.
No summaries, no bullet titles.
Language: ${fields.preferredLanguage || "auto"}
    `;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_image",
              image_base64: base64Image,
            },
          ],
        },
      ],
    });

    const reply =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "I could not analyze the image clearly.";

    res.status(200).json({ reply });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({ error: "Image diagnosis failed" });
  }
}
