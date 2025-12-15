// api/diagnose.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";

// =====================
// OpenAI Client
// =====================
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =====================
// Load ALL knowledge files
// =====================
const DATA_DIR = path.join(process.cwd(), "data");

function loadAllKnowledge() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
  let all = [];
  for (const file of files) {
    try {
      const content = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, file), "utf8")
      );
      if (Array.isArray(content)) {
        all = all.concat(content);
      }
    } catch (e) {
      console.error("Failed loading:", file, e.message);
    }
  }
  return all;
}

const AUTO_KNOWLEDGE = loadAllKnowledge();

// =====================
// Language detection
// =====================
function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  if (/[\u3040-\u30FF]/.test(text)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
  return "en";
}

// =====================
// Greeting only detector
// =====================
function isGreetingOnly(text = "") {
  const t = text.trim().toLowerCase();
  if (!t) return false;

  const greetings = [
    "hi","hello","hey","hola","bonjour","ciao",
    "مرحبا","هلا","السلام","أهلا",
    "привет","こんにちは","안녕하세요","你好"
  ];

  return greetings.some(g => t === g || t.startsWith(g));
}

// =====================
// Short greeting replies
// =====================
function greetingReply(lang) {
  const replies = {
    ar: "أهلًا 👋 كيف أقدر أساعدك اليوم؟",
    en: "Hi 👋 How can I help you today?",
    ru: "Привет 👋 Чем могу помочь?",
    zh: "你好 👋 我可以怎么帮你？",
    ja: "こんにちは 👋 どうしましたか？",
    ko: "안녕하세요 👋 무엇을 도와드릴까요?"
  };
  return replies[lang] || replies.en;
}

// =====================
// Extract relevant issues
// =====================
function findRelevantIssues(message) {
  const t = message.toLowerCase();
  return AUTO_KNOWLEDGE.filter(item =>
    item.symptom_patterns?.some(p => t.includes(p.toLowerCase()))
  ).slice(0, 5);
}

// =====================
// API Handler
// =====================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message required" });
    }

    const lang = detectLanguage(message);

    // 1️⃣ GREETING ONLY
    if (isGreetingOnly(message)) {
      return res.json({
        reply: greetingReply(lang),
        language: lang,
      });
    }

    // 2️⃣ FIND TECHNICAL CONTEXT
    const issues = findRelevantIssues(message);

    // 3️⃣ IF NO TECH CONTEXT → ASK ENGINEER QUESTIONS
    if (issues.length === 0) {
      const ask = {
        ar: `تمام. حتى أقدر أشخّص بدقة، أحتاج:
- نوع السيارة والموديل
- نوع المحرك (بنزين / ديزل / هجين)
- متى يظهر العطل؟ (بارد / حار / سرعة)
- هل توجد لمبة تحذير؟`,
        en: `Got it. To diagnose accurately, please tell me:
- Vehicle make & model
- Engine type (gas / diesel / hybrid)
- When does it happen? (cold / hot / speed)
- Any warning lights?`
      };

      return res.json({
        reply: ask[lang] || ask.en,
        language: lang,
      });
    }

    // 4️⃣ FULL AI DIAGNOSIS
    const prompt = `
You are a professional automotive diagnostic engineer.
Respond in ${lang}.
Be concise and technical.

User issue:
${message}

Relevant known issues:
${JSON.stringify(issues, null, 2)}

Provide:
1. Short technical summary
2. Most likely causes (ranked)
3. What to check next (specific)
4. Safety notes (only if critical)
`;

    const ai = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    return res.json({
      reply: ai.choices[0].message.content,
      language: lang,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Diagnosis failed",
      details: err.message,
    });
  }
}
