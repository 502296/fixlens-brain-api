// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs", // ✅ Vercel يقبلها
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function detectLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  // Spanish/French/German hints
  const lower = t.toLowerCase();
  if (/[ñáéíóúü]/.test(lower) || /\bhola\b/.test(lower)) return "es";
  if (/[àâçéèêëîïôùûüÿœ]/.test(lower) || /\bbonjour\b/.test(lower)) return "fr";
  if (/[äöüß]/.test(lower) || /\bhallo\b/.test(lower)) return "de";
  return "en";
}

function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  const greetings = [
    "hi","hello","hey","hallo","hola","bonjour","ciao",
    "مرحبا","هلا","السلام عليكم","سلام","شلونك","هلو"
  ];
  return greetings.some((g) => t === g || t.startsWith(g));
}

function greetingReply(lang) {
  switch (lang) {
    case "ar":
      return "مرحباً، أنا FixLens Auto. كيف أقدر أساعدك اليوم؟ صف المشكلة أو أرسل صورة/صوت إذا متوفر.";
    case "es":
      return "Hola, soy FixLens Auto. ¿Cómo puedo ayudarte hoy? Describe el problema o envía una foto/sonido si lo tienes.";
    case "fr":
      return "Bonjour, je suis FixLens Auto. Comment puis-je vous aider aujourd’hui ? Décrivez le souci ou envoyez une photo/un son.";
    case "de":
      return "Hallo, ich bin FixLens Auto. Wie kann ich dir heute helfen? Beschreibe das Problem oder sende ein Foto/Audio.";
    case "ru":
      return "Здравствуйте, я FixLens Auto. Чем могу помочь сегодня? Опишите проблему или отправьте фото/аудио.";
    case "zh":
      return "你好，我是 FixLens Auto。今天我怎么帮你？请描述问题，或发送图片/音频。";
    case "ja":
      return "こんにちは。FixLens Autoです。今日はどうしましたか？症状を書いて、必要なら画像/音声も送ってください。";
    default:
      return "Hi, I’m FixLens Auto. How can I help today? Describe the issue or send an image/audio if you have it.";
  }
}

const SYSTEM_PROMPT = `
You are FixLens Auto — an expert automotive diagnostic AI (mechanic-level).
You must be practical, confident, and structured.
You may use internal matched-issues as hints, but never claim certainty.

Output format:
🔧 Quick Summary
⚡ Most Likely Causes (ranked)
🧪 Quick Tests (fast checks)
✅ Next Steps (practical)
⚠️ Safety Notes
`.trim();

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const lang = detectLanguage(message);

    if (isGreeting(message)) {
      return res.status(200).json({ reply: greetingReply(lang), language: lang });
    }

    const issues = findRelevantIssues(message);

    const userPrompt = `
User message:
${message}

Matched issues from internal JSON (hints):
${JSON.stringify(issues, null, 2)}

Respond in: ${lang}
Keep it concise and mechanic-grade.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.25,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "No reply.";
    return res.status(200).json({ reply, language: lang });
  } catch (err) {
    console.error("Diagnose error:", err);
    return res.status(500).json({
      error: "FixLens text diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
