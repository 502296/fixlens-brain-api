// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = {
  runtime: "nodejs18.x",
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// كشف لغة بسيط (اختياري) — يساعد لو تحب تفرض لغة الرد
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  return "en";
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  try {
    setCors(res);

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage, vehicleContext } = req.body || {};

    if (!message || !message.toString().trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const userMessage = message.toString().trim();
    const lang = preferredLanguage || guessLanguage(userMessage) || "auto";

    // ✅ AutoKnowledge: يرجّع أفضل الأعطال المطابقة من كل ملفات data/*.json
    const issues = findRelevantIssues(userMessage, {
      limit: 8,
      minScore: 6,
      // systems: ["engine","electrical"] // (اختياري) لو حبيت تقيّد البحث
    });

    // موديل من ENV حتى تغيّره بسهولة بدون تعديل الكود
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const system = `
You are FixLens Auto — an expert automotive diagnostic assistant.
You must be accurate, safety-first, and avoid guessing when unsure.

Rules:
- Ask 2–5 targeted questions if info is missing.
- Provide step-by-step checks (simple -> advanced).
- Clearly label urgent safety risks.
- If the knowledge-base issues are relevant, use them. If not, rely on general diagnosis.
- Respond in the user's language: ${lang}.
`.trim();

    const contextBlock = `
Vehicle context (optional):
${vehicleContext ? JSON.stringify(vehicleContext, null, 2) : "N/A"}

Relevant matches from FixLens knowledge base (top):
${JSON.stringify(issues, null, 2)}
`.trim();

    const userPrompt = `
User message:
${userMessage}

Output format:
1) Quick Summary (1–2 lines)
2) Most likely causes (bullets)
3) Best checks to confirm (step-by-step)
4) Recommended next steps (bullets)
5) Safety warnings (only if relevant)
6) Questions for the user (if needed)
`.trim();

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: contextBlock },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
    });

    const reply = completion?.choices?.[0]?.message?.content?.trim() || "";

    return res.status(200).json({
      reply,
      language: lang,
      matchedIssues: issues, // مفيد للديباغ (تقدر تشيله لاحقاً)
    });
  } catch (err) {
    console.error("FixLens diagnose error:", err);
    return res.status(500).json({
      error: "Diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
