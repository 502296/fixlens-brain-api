// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false },
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function parseForm(req) {
  const form = formidable({ multiples: false, maxFileSize: 25 * 1024 * 1024 });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const userMessage = (fields.message || "").toString();
    const imageFile = files.image;

    if (!imageFile) {
      return res.status(400).json({ error: "Missing image file. Send multipart field: image" });
    }

    const imgBase64 = fs.readFileSync(imageFile.filepath).toString("base64");

    // 1) Vision observation
    const vision = await client.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0.2,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe what you see in this vehicle-related image. Focus on visible symptoms (leaks, smoke, corrosion, broken hoses, warning lights, damaged parts). If it's not diagnostic, say: NOT DIAGNOSTIC." },
          { type: "input_image", image_url: `data:image/jpeg;base64,${imgBase64}` },
        ],
      }],
    });

    const visionText = (vision.output_text || "").trim();

    // 2) Match internal JSON using message + vision
    const combinedText = `${userMessage}\n\nIMAGE OBSERVATION:\n${visionText}`.trim();
    const matchedIssues = findRelevantIssues(combinedText);

    // 3) Final diagnosis
    const final = await client.responses.create({
      model: "gpt-4.1",
      temperature: 0.25,
      input: [
        {
          role: "system",
          content: `You are FixLens Auto — expert vehicle diagnostic AI.
- Reply in the SAME language as the user (or ${preferredLanguage} if user forced a language).
- Use matched issues as hints (not certainty).
Format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
🛠 Recommended Fix
⚠️ Safety Warnings (only if needed)
If the image is NOT DIAGNOSTIC, say so clearly and rely on the user's text.`,
        },
        {
          role: "user",
          content: `User message:\n${userMessage || "(no text provided)"}\n\nImage observation:\n${visionText || "(none)"}\n\nMatched issues:\n${JSON.stringify(matchedIssues, null, 2)}`,
        },
      ],
    });

    return res.status(200).json({
      reply: (final.output_text || "").trim() || "No reply.",
      language: preferredLanguage,
      image_observation: visionText,
      matched_issues: matchedIssues,
    });
  } catch (e) {
    return res.status(500).json({ error: "Image diagnosis failed", details: e?.message || String(e) });
  }
}
