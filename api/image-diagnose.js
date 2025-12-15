// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  api: { bodyParser: false }, // ✅ مهم لـ multipart
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
    const preferredLanguage =
      (fields.preferredLanguage || "").toString().trim() || null;

    const imageFile = files.image;
    if (!imageFile) {
      return res.status(400).json({
        error: "Image file is required",
        hint: "Send multipart/form-data with field name: image",
      });
    }

    const buffer = fs.readFileSync(imageFile.filepath);
    const base64 = buffer.toString("base64");
    const mime = imageFile.mimetype || "image/jpeg";
    const imageDataUrl = `data:${mime};base64,${base64}`;

    const prompt = buildFixLensPrompt({
      userText: message || "Diagnose the vehicle problem based on the image.",
      preferredLanguage,
      extraContext:
        "The user provided a vehicle/engine image. Use visual clues and be precise.",
    });

    const response = await openai.responses.create({
      model: process.env.FIXLENS_IMAGE_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
      temperature: 0.3,
    });

    return res.status(200).json({
      reply: response.output_text || "",
      language: preferredLanguage,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
