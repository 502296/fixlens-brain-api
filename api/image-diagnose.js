// api/image-diagnose.js
import OpenAI from "openai";

export const config = {
  runtime: "nodejs18.x",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { image, text = "" } = req.body || {};
    if (!image || !String(image).trim()) {
      return res.status(400).json({ error: "Missing base64 image" });
    }

    // مهم: Flutter غالباً يرسل base64 بدون header
    const dataUrl = `data:image/jpeg;base64,${String(image).trim()}`;
    const lang = detectLanguage(text);

    const system = `
You are FixLens Auto — a master automotive technician.
Reply in the user's language: ${lang}.
Be practical, direct, and concise.
If the image alone is not enough, ask ONE short question.
Format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.25,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: text || "Diagnose from this image." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "";
    return res.status(200).json({ reply, language: lang });
  } catch (err) {
    console.error("IMAGE ERROR:", err);
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
