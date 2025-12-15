// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  runtime: "nodejs18.x",
  api: { bodyParser: false }, // مهم جداً
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const message = (fields.message || "").toString();
    const preferredLanguage = (fields.preferredLanguage || "").toString() || null;

    const imageFile = files.image;
    if (!imageFile) return res.status(400).json({ error: "Image file is required (field name: image)" });

    // اقرأ الصورة
    const buf = fs.readFileSync(imageFile.filepath);
    const base64 = buf.toString("base64");
    const mime = imageFile.mimetype || "image/jpeg";
    const dataUrl = `data:${mime};base64,${base64}`;

    const prompt = buildFixLensPrompt({
      userText: message || "Diagnose what you see in the image.",
      preferredLanguage,
      extraContext: "The user provided an engine/vehicle image. Use visual clues."
    });

    // Multimodal (صورة + نص)
    const out = await openai.responses.create({
      model: process.env.FIXLENS_IMAGE_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ],
      temperature: 0.3,
    });

    const reply = out.output_text || "";
    return res.status(200).json({ reply, language: preferredLanguage });
  } catch (err) {
    return res.status(500).json({ error: "Image diagnosis failed", details: String(err?.message || err) });
  }
}
