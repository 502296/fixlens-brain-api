// api/image-diagnose.js
import OpenAI from "openai";
import { readJsonBody } from "./_utils.js";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);
    if (!body) {
      return res.status(400).json({ error: "Missing JSON body" });
    }

    const { image, text, language } = body; // image = base64 (بدون dataURL header)
    if (!image || typeof image !== "string") {
      return res.status(400).json({
        error: "Missing image",
        details: "Send JSON field: image (base64)",
      });
    }

    // خليها Data URL لأن هذا مدعوم رسميًا
    const imageDataUrl = image.startsWith("data:")
      ? image
      : `data:image/jpeg;base64,${image}`;

    const userNote = (text || "").toString();
    const issues = findRelevantIssues(userNote);

    const prompt = `
You are FixLens Auto, a professional vehicle diagnostic assistant.
User language: ${language || "auto"}.
If user language is "auto", detect from user's note.

User note (optional):
${userNote}

Relevant automotive issues from internal database:
${JSON.stringify(issues, null, 2)}

Return:
1) Quick Summary
2) Most likely causes (ranked)
3) Recommended next steps (DIY + shop)
4) Safety warnings (if any)
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    });

    return res.status(200).json({
      reply: response.output_text,
      language: language || "auto",
    });
  } catch (err) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
