import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
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

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files } = await parseForm(req);

    const preferredLanguage = (fields.preferredLanguage || "auto").toString();
    const userMessage = (fields.message || "").toString(); // optional
    const imageFile = files.image; // Flutter لازم يرسل key اسمه "image"

    if (!imageFile) {
      return res.status(400).json({ error: "Missing image file. Send multipart field: image" });
    }

    const imgBase64 = fs.readFileSync(imageFile.filepath).toString("base64");

    // 1) نطلع “وصف بصري” من الصورة (حتى نربطه بالـ JSON)
    const vision = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: `Describe what you see in this vehicle-related image. Focus on visible issues, leaks, corrosion, broken parts, warning lights, smoke, etc. If it's not a car problem image, say so.` },
            { type: "input_image", image_url: `data:image/jpeg;base64,${imgBase64}` },
          ],
        },
      ],
    });

    const visionText =
      vision.output_text?.trim() ||
      (vision.output?.[0]?.content?.[0]?.text?.trim() ?? "");

    // 2) نطابق مع auto_common_issues.json بناءً على (رسالة المستخدم + وصف الصورة)
    const combinedText = `${userMessage}\n\nIMAGE OBSERVATION:\n${visionText}`.trim();
    const matchedIssues = findRelevantIssues(combinedText);

    // 3) نطلب تشخيص نهائي ذكي يعتمد على المطابقة
    const final = await client.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "system",
          content: `You are FixLens Auto, an expert vehicle diagnostic AI.
Rules:
- Respond in user's language: ${preferredLanguage}.
- Use the matched issues list as evidence, but do not claim certainty.
- Provide: Quick Summary, Likely Causes (ranked), Next Steps, Safety Warnings, What to check next.
- If image is not useful, say it clearly and rely on user text.`,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: `User message:\n${userMessage || "(no text provided)"}\n\nImage observation:\n${visionText}\n\nMatched issues from internal JSON:\n${JSON.stringify(matchedIssues, null, 2)}` },
          ],
        },
      ],
    });

    const reply = final.output_text?.trim() || "No reply.";

    return res.status(200).json({
      reply,
      language: preferredLanguage,
      image_observation: visionText,
      matched_issues: matchedIssues,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
