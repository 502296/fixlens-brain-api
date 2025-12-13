// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ---------- Language Detection ---------- */
function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[а-яА-Я]/.test(text)) return "ru";
  if (/[一-龯]/.test(text)) return "zh";
  if (/[ぁ-んァ-ン]/.test(text)) return "ja";
  return "en";
}

/* ---------- Greeting Detection ---------- */
function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  return [
    "hi",
    "hello",
    "hey",
    "hallo",
    "hola",
    "مرحبا",
    "هلا",
    "السلام",
    "سلام",
  ].some(g => t === g || t.startsWith(g));
}

/* ---------- Short Greeting Replies ---------- */
function greetingReply(lang) {
  switch (lang) {
    case "ar":
      return "👋 هلا، شنو المشكلة بالسيارة اليوم؟";
    case "ru":
      return "👋 Привет. В чем проблема с машиной?";
    case "zh":
      return "👋 你好，车子出了什么问题？";
    case "ja":
      return "👋 こんにちは。車の症状を教えてください。";
    default:
      return "👋 Hi. What issue are you having with the car?";
  }
}

/* ---------- SYSTEM PROMPT ---------- */
const SYSTEM_PROMPT = `
You are FixLens Auto.
You are an expert automotive technician and auto electrician.

RULES:
- Users are mechanics, not customers.
- Be direct, practical, and confident.
- No generic advice.
- No unnecessary explanations.
- Never say “go to a mechanic”.

FORMAT (only when diagnosing):
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests
❌ What NOT to do
🧠 Pro Tip
`.trim();

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const lang = detectLanguage(message);

    /* ----- Greeting only ----- */
    if (isGreeting(message)) {
      return res.status(200).json({
        reply: greetingReply(lang),
        language: lang,
      });
    }

    /* ----- Real Diagnosis ----- */
    const issues = findRelevantIssues(message);

    const userPrompt = `
User message:
${message}

Relevant known issues:
${JSON.stringify(issues, null, 2)}

Respond in ${lang}.
Follow the format strictly.
Be concise and practical.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim();

    return res.status(200).json({
      reply,
      language: lang,
    });

  } catch (err) {
    console.error("Diagnose error:", err);
    return res.status(500).json({
      error: "FixLens text diagnosis failed",
      details: err.message,
    });
  }
}
