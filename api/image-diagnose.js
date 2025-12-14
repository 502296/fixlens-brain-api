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
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function pickFile(files, key) {
  const f = files?.[key];
  if (!f) return null;
  return Array.isArray(f) ? f[0] : f;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const userMessage = (fields.message || "").toString().trim();

    const imageFile = pickFile(files, "image"); // ✅ لازم Flutter يرسل باسم image
    if (!imageFile?.filepath) {
      return res.status(400).json({ error: "Missing image file. Send multipart field: image" });
    }

    const imgBase64 = fs.readFileSync(imageFile.filepath).toString("base64");
    const dataUrl = `data:image/jpeg;base64,${imgBase64}`;

    // 1) Vision observation
    const vision = await client.responses.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Describe what you see in this vehicle-related image. Focus on visible symptoms (leaks, smoke, corrosion, damaged parts, warning lights). If it’s not useful, say so." },
          { type: "input_image", image_url: dataUrl },
        ],
      }],
    });

    const visionText = (vision.output_text || "").trim();

    // 2) Match against JSON using user text + vision observation
    const combined = `${userMessage}\n\nIMAGE_OBSERVATION:\n${visionText}`.trim();
    const matched = findRelevantIssues(combined);

    // 3) Final diagnosis
    const lang = (preferredLanguage !== "auto") ? preferredLanguage : (userMessage ? undefined : "en");

    const final = await client.responses.create({
      model: "gpt-4o",
      temperature: 0.25,
      input: [
        {
          role: "system",
          content: `You are FixLens Auto — expert vehicle diagnostics.
Respond in user's language (${preferredLanguage}).
Use matched issues as hints, never claim certainty.
Format:
1) Quick Summary
2) Most Likely Causes (ranked)
3) Quick Tests
4) Recommended Next Steps
5) Safety Warnings`,
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
`User message:
${userMessage || "(no text)"}

Image observation:
${visionText || "(none)"}

Matched issues (internal JSON):
${JSON.stringify(matched, null, 2)}`
            }
          ],
        },
      ],
    });

    const reply = (final.output_text || "").trim() || "No reply.";
    return res.status(200).json({
      reply,
      image_observation: visionText,
      matched_issues: matched,
      language: preferredLanguage,
    });

  } catch (e) {
    console.error("Image diagnose error:", e);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
