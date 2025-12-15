// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function normalizeBase64Image(input) {
  if (!input) return null;
  let s = String(input);

  // لو جايك data:image/...;base64,xxx نشيل المقدمة
  const idx = s.indexOf("base64,");
  if (idx !== -1) s = s.substring(idx + "base64,".length);

  // تنظيف مسافات
  s = s.trim();
  return s || null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const body = await readJsonBody(req);

    const imageB64 = normalizeBase64Image(body.image);
    const note = (body.text || body.note || "").toString();
    const preferredLanguage = (body.language || "auto").toString();

    if (!imageB64) {
      return res.status(400).json({
        error: "Missing image",
        details: "Send JSON with field: image (base64).",
      });
    }

    const issues = findRelevantIssues(note || "");

    // ✅ نرسل الصورة كـ data URL (ممتاز لـ Vercel + OpenAI)
    const dataUrl = `data:image/jpeg;base64,${imageB64}`;

    const prompt = `
You are FixLens Auto, an expert vehicle diagnostic AI.
User language: ${preferredLanguage} (if "auto", reply in the user's language).
User note (optional): ${note || "(none)"}

Relevant automotive issues from internal database (based on note, may be empty):
${JSON.stringify(issues, null, 2)}

Analyze the image. If it's not a vehicle-related image, say so politely.
Return:
1) What you see (key observations)
2) Most likely issues (ranked)
3) Next steps / checks
4) Safety warnings (if any)
`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const reply = resp?.choices?.[0]?.message?.content || "No reply.";

    return res.status(200).json({
      reply,
      language: preferredLanguage,
    });
  } catch (e) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
