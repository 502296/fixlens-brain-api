// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Vercel Serverless: req.body قد يكون undefined، لذلك نقرأه يدويًا
async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;

  let raw = "";
  for await (const chunk of req) raw += chunk;

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);

    if (!body) {
      return res.status(400).json({
        error: "Invalid or missing JSON body",
        hint: "Send Content-Type: application/json with { image: <base64>, text?: <string>, language?: <code> }",
      });
    }

    const { image, text, language } = body;

    if (!image || typeof image !== "string" || image.trim().length < 50) {
      return res.status(400).json({
        error: "Missing image. Send JSON field: image (base64)",
      });
    }

    const detected = detectLanguage(text || "");
    const lang = language && language !== "auto" ? language : detected;

    // data url
    const dataUrl = `data:image/jpeg;base64,${image}`;

    // 1) Vision observation
    const vision = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Describe what you see in this vehicle-related image. Focus on visible issues, warning lights, leaks, smoke, broken parts. If not useful, say so.",
            },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    });

    const visionText = (vision.output_text || "").trim();

    // 2) match issues
    const combined = `${text || ""}\n\nIMAGE OBSERVATION:\n${visionText}`.trim();
    const matchedIssues = findRelevantIssues(combined);

    // 3) final diagnosis
    const final = await client.responses.create({
      model: "gpt-4.1",
      input: [
        {
          role: "system",
          content: `You are FixLens Auto, expert vehicle diagnostic AI.
Respond in: ${lang}.
Use matched issues as hints (not certainty).
Format:
🔧 Quick Summary
⚡ Likely Causes (ranked)
🧪 Quick Tests
⚠️ Safety Warnings
❌ What NOT to do
🧠 Pro Tip`,
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `User note:\n${text || "(no text)"}\n\nImage observation:\n${visionText}\n\nMatched issues:\n${JSON.stringify(
                matchedIssues,
                null,
                2
              )}`,
            },
          ],
        },
      ],
      temperature: 0.3,
    });

    const reply = (final.output_text || "").trim() || "No reply.";

    return res.status(200).json({
      reply,
      language: lang,
      image_observation: visionText,
      matched_issues: matchedIssues,
    });
  } catch (err) {
    console.error("Image diagnose error:", err);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
