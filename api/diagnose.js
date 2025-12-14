// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function detectLanguage(text = "") {
  const t = text.trim();
  if (!t) return "en";
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[а-яА-Я]/.test(t)) return "ru";
  if (/[一-龯]/.test(t)) return "zh";
  if (/[ぁ-んァ-ン]/.test(t)) return "ja";
  if (/[가-힣]/.test(t)) return "ko";
  return "en";
}

function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  const greetings = [
    "hi","hello","hey","hola","hallo",
    "مرحبا","هلا","السلام عليكم","سلام","شلونك","هلو",
  ];
  return greetings.some(g => t === g || t.startsWith(g));
}

function professionalGreeting(lang) {
  switch (lang) {
    case "ar":
      return "مرحبًا. أنا FixLens Auto. كيف أستطيع مساعدتك اليوم؟ صف المشكلة أو ارسل صورة/صوت إن توفر.";
    case "ru":
      return "Здравствуйте. Я FixLens Auto. Чем могу помочь сегодня? صف المشكلة أو ارسل صورة/صوت إن توفر.";
    case "zh":
      return "您好。我是 FixLens Auto。今天我能如何帮您？请描述问题，或发送图片/音频。";
    case "ja":
      return "こんにちは。FixLens Auto です。どのようにお手伝いできますか？症状を入力するか、画像/音声を送ってください。";
    case "ko":
      return "안녕하세요. FixLens Auto입니다. 오늘 무엇을 도와드릴까요? 증상을 입력하거나 이미지/오디오를 보내주세요.";
    default:
      return "Hello. I’m FixLens Auto. How can I help you today? Describe the issue or send an image/audio if available.";
  }
}

const SYSTEM_PROMPT = `
You are FixLens Auto — an expert vehicle diagnostics assistant.
You must be practical, structured, and confident.
You can use internal matched issues as hints but never claim certainty.

When diagnosing, respond with:
1) Quick Summary
2) Most Likely Causes (ranked)
3) Quick Tests
4) Recommended Next Steps
5) Safety Warnings

Keep it clear and professional.
`.trim();

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, preferredLanguage } = req.body || {};
    const msg = (message || "").trim();
    if (!msg) return res.status(400).json({ error: "Message is required" });

    const lang = (preferredLanguage && preferredLanguage !== "auto")
      ? preferredLanguage
      : detectLanguage(msg);

    if (isGreeting(msg)) {
      return res.status(200).json({ reply: professionalGreeting(lang), language: lang });
    }

    const matched = findRelevantIssues(msg);

    const prompt = `
User message:
${msg}

Matched issues from internal JSON:
${JSON.stringify(matched, null, 2)}

Respond in: ${lang}
Follow the format strictly.
`.trim();

    const out = await client.responses.create({
      model: "gpt-4o",
      temperature: 0.25,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });

    const reply = (out.output_text || "").trim() || "No reply.";
    return res.status(200).json({ reply, language: lang, matched_issues: matched });

  } catch (e) {
    console.error("Text diagnose error:", e);
    return res.status(500).json({
      error: "FixLens text diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
