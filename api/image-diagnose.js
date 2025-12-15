// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false }, // ✅ ضروري لاستقبال multipart
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFileSize: 10 * 1024 * 1024, // 10MB
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { fields, files } = await parseForm(req);

    const message = (fields.message || "").toString().trim();
    const preferredLanguage = (fields.preferredLanguage || "").toString().trim() || null;

    // ✅ لازم اسم الحقل في Flutter يكون 'image'
    const imageFile = files.image;
    if (!imageFile) {
      return res.status(400).json({
        error: "Image file is required",
        hint: "Send multipart/form-data with field name: image",
      });
    }

    const buf = fs.readFileSync(imageFile.filepath);
    const base64 = buf.toString("base64");
    const mime = imageFile.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${base64}`;

    const prompt = buildFixLensPrompt({
      userText: message || "Diagnose the vehicle problem based on the image.",
      preferredLanguage,
      extraContext:
        "The user provided a vehicle/engine image. Use visual clues. If uncertain, ask targeted questions.",
    });

    // ✅ Responses API multimodal (صورة + نص)
    const out = await openai.responses.create({
      model: process.env.FIXLENS_IMAGE_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      temperature: 0.3,
    });

    const reply = out.output_text || "";

    return res.status(200).json({
      reply,
      language: preferredLanguage,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
