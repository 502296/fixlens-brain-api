// api/image-diagnose.js
import OpenAI from "openai";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function guessLanguage(text) {
  if (!text || !text.trim()) return "auto";
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { image, text = "", preferredLanguage } = req.body ?? {};
    if (!image) return res.status(400).json({ error: "Missing base64 image" });

    const lang = preferredLanguage || guessLanguage(text);

    const ai = await client.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Reply in ${lang}. Be concise. If user gave no context, ask ONE short question.` },
            { type: "input_text", text: text || "" },
            {
              type: "input_file",
              mime_type: "image/jpeg",
              data: image,
            },
          ],
        },
      ],
    });

    return res.status(200).json({ reply: ai.output_text || "", language: lang });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    return res.status(500).json({ error: "Image diagnosis failed", details: err?.message || String(err) });
  }
}
