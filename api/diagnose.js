// api/diagnose.js
import OpenAI from "openai";
import { buildFixLensPrompt } from "../lib/promptBuilder.js";

export const config = {
  api: { bodyParser: true }, // الافتراضي، آمن للنص
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const prompt = buildFixLensPrompt({
      userText: message,
      preferredLanguage,
    });

    const completion = await openai.chat.completions.create({
      model: process.env.FIXLENS_TEXT_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are FixLens Auto." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
    });

    const reply = completion.choices?.[0]?.message?.content || "";

    return res.status(200).json({
      reply,
      language: preferredLanguage || null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Text diagnosis failed",
      details: String(err?.message || err),
    });
  }
}
