// FORCE NEW DEPLOY
// api/diagnose.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =========================
// Load all knowledge files
// =========================
function loadKnowledge() {
  const dataDir = path.join(process.cwd(), "data");
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith(".json"));

  let knowledge = [];
  for (const file of files) {
    try {
      const content = JSON.parse(
        fs.readFileSync(path.join(dataDir, file), "utf8")
      );
      knowledge.push({ file, content });
    } catch (e) {
      console.error(`Failed to load ${file}`, e);
    }
  }
  return knowledge;
}

const AUTO_KNOWLEDGE = loadKnowledge();

// =========================
// Language detection
// =========================
function detectLanguage(text = "") {
  if (/[\u0600-\u06FF]/.test(text)) return "ar";
  if (/[\u0400-\u04FF]/.test(text)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(text)) return "zh";
  if (/[\u3040-\u30FF]/.test(text)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(text)) return "ko";
  return "en";
}

// =========================
// Greeting detection
// =========================
function isGreetingOnly(text = "") {
  const t = text.trim().toLowerCase();
  if (!t) return false;

  const greetings = [
    "hi", "hello", "hey",
    "مرحبا", "هلا", "السلام", "أهلاً",
    "hola", "bonjour", "ciao",
    "привет", "こんにちは", "안녕하세요"
  ];

  return greetings.some(g => t === g || t.startsWith(g));
}

// =========================
// Greeting replies
// =========================
function greetingReply(lang) {
  switch (lang) {
    case "ar": return "أهلاً 👋 كيف أقدر أساعدك اليوم؟";
    case "ru": return "Привет 👋 Чем могу помочь?";
    case "zh": return "你好 👋 我可以帮你什么？";
    case "ja": return "こんにちは 👋 どんなお手伝いができますか？";
    case "ko": return "안녕하세요 👋 무엇을 도와드릴까요?";
    default: return "Hi 👋 How can I help you today?";
  }
}

// =========================
// Main handler
// =========================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Empty message" });
    }

    const language = detectLanguage(message);

    // 1️⃣ Greeting only
    if (isGreetingOnly(message)) {
      return res.json({
        reply: greetingReply(language),
        language,
      });
    }

    // 2️⃣ Real mechanical problem
    const systemPrompt = `
You are FixLens, a professional automotive diagnostic engineer.
You speak ONLY in the user's language.
Do NOT use sections, titles, summaries, or safety disclaimers.
Respond naturally like an experienced mechanic talking to another technician.
Be precise, realistic, and practical.

Use this automotive knowledge as reference:
${JSON.stringify(AUTO_KNOWLEDGE).slice(0, 12000)}

Your goal:
- Analyze the problem
- Suggest likely causes
- Ask smart follow-up questions (vehicle, engine, fuel, codes)
- Keep the response concise and professional
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0.3,
    });

    return res.json({
      reply: completion.choices[0].message.content,
      language,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "FixLens diagnosis failed",
      details: err.message,
    });
  }
}
