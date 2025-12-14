// api/image-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs",            // ✅
  api: { bodyParser: false },   // ✅ حتى ندعم multipart + نقرأ JSON يدويًا
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseForm(req) {
  const form = formidable({ multiples: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

function detectLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const contentType = String(req.headers["content-type"] || "").toLowerCase();

    let preferredLanguage = "auto";
    let userMessage = "";
    let base64Image = null;

    // ✅ 1) JSON (مثل Flutter عندك)
    if (contentType.includes("application/json")) {
      const body = await readJsonBody(req);
      preferredLanguage = String(body.language || body.preferredLanguage || "auto");
      userMessage = String(body.text || body.note || body.message || "");
      base64Image = body.image || body.imageBase64 || null;

      if (!base64Image) {
        return res.status(400).json({ error: "Missing image base64. Send field: image" });
      }
    }
    // ✅ 2) multipart (لو احتجته لاحقاً)
    else if (contentType.includes("multipart/form-data")) {
      const { fields, files } = await parseForm(req);
      preferredLanguage = String(fields.preferredLanguage || fields.language || "auto");
      userMessage = String(fields.message || fields.text || fields.note || "");

      const imageFile = files.image;
      if (!imageFile) {
        return res.status(400).json({ error: "Missing image file. Send multipart field: image" });
      }
      base64Image = fs.readFileSync(imageFile.filepath).toString("base64");
    } else {
      return res.status(415).json({ error: "Unsupported content-type. Use application/json or multipart/form-data." });
    }

    const lang = preferredLanguage === "auto"
      ? detectLanguage(userMessage)
      : String(preferredLanguage);

    // 🔎 Matching من الـ JSON بناءً على كلام المستخدم (اختياري)
    const matchedIssues = findRelevantIssues(userMessage);

    const system = `
You are FixLens Auto — an expert mechanic-level diagnostic AI.
Respond in: ${lang}
Use matched issues as hints only.
Output format:
🔧 Quick Summary
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
✅ Next Steps
⚠️ Safety Notes
`.trim();

    const promptText = `
User message:
${userMessage || "(no text provided)"}

Matched issues (hints):
${JSON.stringify(matchedIssues, null, 2)}

Look at the image and infer visible symptoms (leaks, corrosion, broken parts, warning lights, smoke, loose hoses, etc.).
If the image is generic or not helpful, say it clearly and rely more on the user message.
`.trim();

    // ✅ Vision عبر chat.completions (ثابت على Vercel)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.25,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64Image}` },
            },
          ],
        },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "No reply.";
    return res.status(200).json({
      reply,
      language: lang,
      matched_issues: matchedIssues,
    });
  } catch (e) {
    console.error("Image diagnose error:", e);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
