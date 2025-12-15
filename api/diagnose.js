// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function guessLanguage(text) {
  if (!text || !text.trim()) return "en";
  const t = text.trim();
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  return "en";
}

function isGreetingOnly(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  // Very short greetings in many languages
  const greetings = [
    "hi","hello","hey","yo","good morning","good evening",
    "مرحبا","هلا","هلو","السلام","السلام عليكم","شلونك","هَي",
    "hola","buenas","bonjour","salut","ciao","hallo","привет","здравств",
  ];

  // if message has any technical words, not a greeting-only
  const technicalHints = [
    "noise","leak","check engine","misfire","overheat","vibration","stall",
    "صوت","تهريب","تسريب","لمبة","حرارة","اهتزاز","تفتفه","ضعف","دخان",
    "code","p0","p1","rpm","obd","scan"
  ];

  if (technicalHints.some((k) => t.includes(k))) return false;

  // greeting-only if it matches greeting and is short
  return greetings.some((g) => t === g || t.startsWith(g + " ")) && t.length <= 30;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, preferredLanguage } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const userText = String(message).trim();
    const lang = preferredLanguage || guessLanguage(userText);

    // ✅ Short greeting response (no long template)
    if (isGreetingOnly(userText)) {
      const greetingPrompt = `
You are FixLens Auto, a professional mechanic assistant.
Reply in: ${lang}
User said: "${userText}"

Rules:
- Keep it 1–2 short lines only.
- Ask ONE helpful question to start diagnosis (make/model/year/engine OR main symptom).
- No long lists, no numbered sections.
`;
      const g = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [{ role: "user", content: greetingPrompt }],
      });

      return res.status(200).json({ reply: g.choices?.[0]?.message?.content || "" , language: lang });
    }

    // ✅ Knowledge matches from ALL data files
    const issues = findRelevantIssues(userText, { maxResults: 7, minScore: 6 });

    const prompt = `
You are FixLens Auto — a senior diagnostic technician.
User language: ${lang}

User message:
${userText}

Matched issues from FixLens knowledge base (use these!):
${JSON.stringify(issues, null, 2)}

Hard Rules:
- Be realistic and technician-grade. No generic “textbook” fluff.
- If vehicle details are missing, FIRST ask essential questions (short list), THEN give a preliminary ranked hypothesis.
- Keep the response concise for pros.

Output format (always):
A) Quick take (1–2 lines)
B) 5 key questions to narrow it down (make/model/year/engine, mileage, when it happens, warning lights/codes, recent work)
C) Likely causes (ranked, 3–6 items) — connect them to the matched knowledge when possible
D) Next checks (step-by-step, safe, practical)
E) Safety note (only if relevant)

Important:
- If the symptom indicates a dangerous condition, clearly warn to stop driving.
- If no matches found, still behave like a mechanic and ask questions instead of making up specifics.
`;

    const ai = await client.chat.completions.create({
      model: "gpt-4o", // قوي للنصوص التشخيصية
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    });

    const reply = ai.choices?.[0]?.message?.content || "";
    return res.status(200).json({ reply, language: lang, matchedIssuesCount: issues.length });

  } catch (err) {
    return res.status(500).json({
      error: "FixLens text diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
