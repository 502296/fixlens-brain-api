// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false, // 🔥 مهم جدًا
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const form = formidable({
      multiples: false,
      keepExtensions: true,
    });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const imageFile = files.image;
    if (!imageFile) {
      return res.status(400).json({ error: "No image received" });
    }

    const imageBuffer = fs.readFileSync(imageFile.filepath);

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are FixLens Auto, an expert vehicle diagnostic AI. Analyze the image and explain possible issues.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: fields.note || "Analyze this vehicle image." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBuffer.toString("base64")}`,
              },
            },
          ],
        },
      ],
    });

    res.json({
      reply: response.choices[0].message.content,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Image diagnosis failed",
      details: err.message,
    });
  }
}
