// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  const greetings = ["hi","hello","hey","hallo","hola","مرحبا","هلا","السلام","سلام","شلونك","هلو"];
  return greetings.some(g => t === g || t.startsWith(g));
}

function greetingReply(lang) {
  switch (lang) {
    case "ar":
      return "مرحباً، أنا FixLens Auto. كيف أقدر أساعدك اليوم؟ صف المشكلة أو ارسل صورة/صوت إذا متوفر.";
    case "ru":
      return "Здравствуйте. Я FixLens Auto. Чем могу помочь сегодня? Опишите проблему или отправьте фото/аудио.";
    case "zh":
      return "你好，我是 FixLens Auto。今天我能怎么帮你？描述问题或发送图片/音频。";
    case "ja":
      return "こんにちは。FixLens Autoです。今日はどうしましたか？症状を書いて、画像/音声も送れます。";
    default:
      return "Hello — I’m FixLens Auto. How can I help you today? Describe the issue, or send a photo/voice note if available.";
  }
}

const SYSTEM_PROMPT = `
You are FixLens Auto — an expert automotive diagnostician (mechanic + auto electrician).
Be practical, confident, and structured. No fluff.

When diagnosing, follow this format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip

Rules:
- Ask 1–2 smart follow-up questions only if needed.
- Don’t claim certainty.
- Never say "go to a mechanic".
`.trim();

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, language } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "Message is required" });

    const detected = detectLanguage(message);
    const lang = (language && language !== "auto") ? language : detected;

    if (isGreeting(message)) {
      return res.status(200).json({ reply: greetingReply(lang), language: lang });
    }

    const issues = findRelevantIssues(message);

    const userPrompt = `
User message:
${message}

Matched issues from internal JSON:
${JSON.stringify(issues, null, 2)}

Respond in ${lang}. Follow the format strictly.
`.trim();

    const out = await client.responses.create({
      model: "gpt-4.1",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3
    });

    const reply = (out.output_text || "").trim() || "No reply.";
    return res.status(200).json({ reply, language: lang });
  } catch (err) {
    console.error("Diagnose error:", err);
    return res.status(500).json({ error: "FixLens text diagnosis failed", details: err?.message || String(err) });
  }
}
