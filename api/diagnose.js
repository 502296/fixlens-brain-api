// api/diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

export const config = { runtime: "nodejs18.x" };

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ===== Language + Greeting =====
function detectLanguage(text) {
  if (!text || !text.trim()) return "en";
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Cyrillic
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // Chinese
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // Japanese
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko"; // Korean
  if (/[ñáéíóúü¿¡]/i.test(t)) return "es";   // Spanish hint
  if (/[àâçéèêëîïôûùüÿœ]/i.test(t)) return "fr"; // French hint
  return "en";
}

function isGreetingOnly(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  // If it includes obvious car/problem signals -> not greeting only
  const problemSignals = [
    "noise","knock","tick","rattle","vibration","shake","leak","smoke","overheat",
    "misfire","stall","rough","check engine","abs","srs","airbag","p0","u0","c0","b0",
    "صوت","طقطقة","اهتزاز","رجّة","تسريب","دخان","حرارة","سخونة","تقطيع","لمبة","فحص","كود",
  ];
  for (const s of problemSignals) {
    if (t.includes(s)) return false;
  }

  // Greetings list
  const greetings = [
    "hi","hello","hey","yo","good morning","good evening",
    "hola","buenas",
    "salut","bonjour",
    "hallo",
    "ciao",
    "مرحبا","هلا","هلاو","السلام عليكم","سلام","هاي","شلونك",
    "привет","здравствуйте",
    "こんにちは",
    "你好","您好",
    "안녕하세요",
  ];

  // must be short-ish
  if (t.length > 40) return false;

  return greetings.some((g) => t === g || t.startsWith(g + " ") || t.endsWith(" " + g));
}

function greetingReply(lang) {
  const map = {
    ar: "هلا! شنو المشكلة بسيارتك اليوم؟ اكتب (النوع/السنة/المحرك) + الأعراض، وإذا عندك كود OBD ارسله.",
    en: "Hi! What’s going on with the vehicle today? Share make/year/engine + symptoms. If you have OBD codes, paste them.",
    es: "¡Hola! ¿Qué problema tiene el vehículo hoy? Marca/año/motor + síntomas. Si tienes códigos OBD, envíalos.",
    fr: "Salut ! Quel souci avec le véhicule ? Marque/année/moteur + symptômes. Si tu as des codes OBD, envoie-les.",
    ru: "Привет! Что происходит с авто? Марка/год/двигатель + симптомы. Если есть OBD-коды — пришлите.",
    zh: "你好！车辆现在有什么问题？请发品牌/年份/发动机 + 症状；有OBD报码也发我。",
    ja: "こんにちは！車の症状は？車種/年式/エンジン + 症状、OBDコードがあれば送ってください。",
    ko: "안녕하세요! 차량 증상이 뭐예요? 차종/연식/엔진 + 증상, OBD 코드가 있으면 보내주세요.",
  };
  return map[lang] || map.en;
}

// ===== Main handler =====
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { message, preferredLanguage } = req.body || {};
    const userMessage = (message || "").toString();

    if (!userMessage.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const lang = (preferredLanguage || detectLanguage(userMessage) || "en").toString();

    // Greeting-only => short reply (no mechanic report)
    if (isGreetingOnly(userMessage)) {
      return res.status(200).json({ reply: greetingReply(lang), language: lang });
    }

    // Pull relevant issues from ALL data/*.json
    const relevant = findRelevantIssues(userMessage, { limit: 12 });

    // Build a mechanic-grade prompt (ChatGPT-like, no headings)
    const system = `
You are FixLens Auto: a professional automotive diagnostic assistant for technicians.
Style rules:
- Reply in the user's language (${lang}).
- Write like ChatGPT: natural, practical, concise.
- Do NOT use section headings like "Quick Summary / Safety / Recommended".
- Ask 2–5 targeted questions if key info is missing (make/model/year/engine, mileage, DTC codes, when it happens).
- Give likely causes in ranked bullets, then quick test steps, then suggested fixes.
- Mention safety only when truly important, as one short sentence (no "Safety warnings" header).
- Use the internal issues below as hints; don't copy them verbatim.
`;

    const context = `
User message:
${userMessage}

Internal matched issues (from data/*.json):
${JSON.stringify(relevant, null, 2)}
`;

    const completion = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o-mini",
      temperature: 0.35,
      messages: [
        { role: "system", content: system.trim() },
        { role: "user", content: context.trim() },
      ],
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "Sorry — I couldn't generate a response.";
    return res.status(200).json({ reply, language: lang });
  } catch (err) {
    return res.status(500).json({
      error: "Diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
