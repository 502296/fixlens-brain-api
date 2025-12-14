// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs",
};

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ---------- Language Detection (fast heuristic) ---------- */
function detectLanguage(text = "") {
  const t = (text || "").trim();
  if (!t) return "auto";
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[а-яА-Я]/.test(t)) return "ru";
  if (/[一-龯]/.test(t)) return "zh";
  if (/[ぁ-んァ-ン]/.test(t)) return "ja";
  if (/[가-힣]/.test(t)) return "ko";
  return "auto"; // let model respond in same language
}

/* ---------- Greeting Detection ---------- */
function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  const greetings = [
    "hi", "hello", "hey", "hallo", "hola", "bonjour", "ciao",
    "مرحبا", "هلا", "السلام عليكم", "السلام", "سلام",
    "اهلا", "أهلا", "هاي"
  ];
  // greeting-only if very short or exactly greeting
  return greetings.some(g => t === g || (t.startsWith(g) && t.length <= g.length + 2));
}

/* ---------- Professional Greeting Reply (template) ---------- */
function professionalGreeting(lang) {
  if (lang === "ar") {
    return "مرحبًا 👋 أنا FixLens Auto. كيف أستطيع مساعدتك اليوم؟ صف المشكلة أو أرسل صورة/صوت وسأحللها فورًا.";
  }
  if (lang === "ru") {
    return "Здравствуйте 👋 Я FixLens Auto. Чем могу помочь сегодня? Опишите проблему или отправьте фото/аудио — я сразу проанализирую.";
  }
  if (lang === "zh") {
    return "你好 👋 我是 FixLens Auto。今天我可以怎么帮你？描述问题或发送图片/音频，我会立即分析。";
  }
  if (lang === "ja") {
    return "こんにちは 👋 FixLens Autoです。今日はどのようにお手伝いできますか？症状を書いてください。画像や音声でもOKです。";
  }
  if (lang === "ko") {
    return "안녕하세요 👋 FixLens Auto입니다. 어떤 문제가 있나요? 증상을 적거나 사진/오디오를 보내주시면 바로 분석할게요.";
  }
  // fallback: let English be default
  return "Hello 👋 I’m FixLens Auto. How can I help today? Describe the issue or send an image/audio and I’ll analyze it right away.";
}

/* ---------- SYSTEM PROMPT (super smart mechanic mode) ---------- */
const SYSTEM_PROMPT = `
You are FixLens Auto — a world-class diagnostic assistant for vehicles.
You speak the user's language automatically (match the language of the user's message).

Audience:
- Most users are DIYers or mechanics.
Style:
- Professional, confident, concise, and practical.
- No fluff. No generic advice.
- Do NOT say “go to a mechanic”.
- Ask 1–3 key questions ONLY if needed.

When diagnosing, follow this format:
🔧 Quick Diagnosis
⚡ Most Likely Causes (ranked)
🧪 Quick Tests (fast checks)
🛠 Recommended Fix (practical steps)
⚠️ Safety Warnings (only if relevant)
`.trim();

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, preferredLanguage } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "Message is required" });

    const lang = (preferredLanguage && String(preferredLanguage).trim()) ? String(preferredLanguage).trim() : detectLanguage(message);

    // Greeting-only shortcut
    if (isGreeting(message)) {
      return res.status(200).json({ reply: professionalGreeting(lang), language: lang });
    }

    // JSON matching
    const matchedIssues = findRelevantIssues(message);

    const userPrompt = `
User message:
${message}

Matched internal issues (from auto_common_issues.json):
${JSON.stringify(matchedIssues, null, 2)}

Respond in the SAME language as the user's message.
If the message is unclear, ask 1–3 targeted questions.
`.trim();

    const out = await client.responses.create({
      model: "gpt-4.1",
      temperature: 0.25,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });

    const reply = (out.output_text || "").trim() || "No reply.";

    return res.status(200).json({ reply, language: lang, matched_issues: matchedIssues });

  } catch (err) {
    console.error("Diagnose error:", err);
    return res.status(500).json({ error: "FixLens text diagnosis failed", details: err?.message || String(err) });
  }
}
