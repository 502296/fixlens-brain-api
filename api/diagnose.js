// api/diagnose.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";

export const config = {
  runtime: "nodejs18.x",
};

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =========================
// Language + Greeting Logic
// =========================
function detectLanguage(text) {
  if (!text || !text.trim()) return "en";
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Cyrillic
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // Chinese
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // Japanese
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko"; // Korean
  return "en";
}

function isGreetingOnly(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;

  // If it already contains problem signals, don't treat as greeting
  const technicalHints = [
    "noise",
    "leak",
    "check engine",
    "misfire",
    "overheat",
    "vibration",
    "stall",
    "smoke",
    "code",
    "p0",
    "p1",
    "rpm",
    "obd",
    "scan",
    "صوت",
    "تسريب",
    "تهريب",
    "لمبة",
    "حرارة",
    "اهتزاز",
    "تفتفه",
    "ضعف",
    "دخان",
    "كود",
    "فحص",
    "يطفئ",
    "يطفي",
    "رجة",
  ];
  if (technicalHints.some((k) => t.includes(k))) return false;

  const greetings = [
    "hi",
    "hello",
    "hey",
    "yo",
    "good morning",
    "good evening",
    "مرحبا",
    "هلا",
    "هلو",
    "السلام عليكم",
    "السلام",
    "شلونك",
    "أهلاً",
    "اهلا",
    "hola",
    "buenas",
    "bonjour",
    "salut",
    "ciao",
    "hallo",
    "привет",
    "здравств",
    "こんにちは",
    "もしもし",
    "안녕하세요",
    "你好",
  ];

  if (t.length > 40) return false;
  return greetings.some((g) => t === g || t.startsWith(g + " "));
}

// =========================
// AutoKnowledge Loader (data/*.json)
// =========================
let cachedIssues = null;

function safeReadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    return null;
  }
}

function normalizeArray(maybeArray) {
  if (!maybeArray) return [];
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray];
}

function loadAllIssues() {
  if (cachedIssues) return cachedIssues;

  const dataDir = path.join(process.cwd(), "data");

  let files = [];
  try {
    files = fs
      .readdirSync(dataDir)
      .filter((f) => f.toLowerCase().endsWith(".json"));
  } catch (e) {
    // data folder missing
    cachedIssues = [];
    return cachedIssues;
  }

  const all = [];

  for (const file of files) {
    const full = path.join(dataDir, file);
    const data = safeReadJSON(full);
    if (!data) continue;

    const items = Array.isArray(data) ? data : normalizeArray(data.issues || data.items || data.data);
    for (const it of items) {
      if (!it || typeof it !== "object") continue;

      all.push({
        id: it.id || `${file}:${Math.random().toString(16).slice(2)}`,
        source_file: file,
        system: it.system || it.category || file.replace(".json", ""),
        symptom_short: it.symptom_short || it.title || it.symptom || "",
        symptom_patterns: normalizeArray(it.symptom_patterns || it.patterns || it.keywords),
        dtc_codes: normalizeArray(it.dtc_codes || it.codes),
        likely_causes: normalizeArray(it.likely_causes || it.causes),
        checks: normalizeArray(it.checks || it.diagnostic_checks || it.tests),
        fixes: normalizeArray(it.fixes || it.repairs || it.solutions),
        severity: it.severity || "",
        urgency: it.urgency || "",
        notes: it.notes || it.details || "",
      });
    }
  }

  cachedIssues = all;
  return cachedIssues;
}

function scoreIssue(issue, textLower) {
  let score = 0;

  // Strong signal: DTC match
  for (const code of issue.dtc_codes || []) {
    if (!code) continue;
    const c = String(code).toLowerCase();
    if (textLower.includes(c)) score += 10;
  }

  // Patterns match
  for (const p of issue.symptom_patterns || []) {
    if (!p) continue;
    const pat = String(p).toLowerCase();
    if (pat.length < 3) continue;
    if (textLower.includes(pat)) score += 4;
  }

  // Symptom short match
  if (issue.symptom_short) {
    const s = String(issue.symptom_short).toLowerCase();
    if (s && s.length >= 4 && textLower.includes(s)) score += 3;
  }

  // System/category hint
  if (issue.system) {
    const sys = String(issue.system).toLowerCase();
    if (sys && textLower.includes(sys)) score += 1;
  }

  return score;
}

function findRelevantIssues(userText, limit = 7) {
  const textLower = (userText || "").toLowerCase();
  const issues = loadAllIssues();

  const scored = issues
    .map((it) => ({ ...it, _score: scoreIssue(it, textLower) }))
    .filter((it) => it._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);

  // Return compact
  return scored.map((it) => ({
    id: it.id,
    system: it.system,
    symptom_short: it.symptom_short,
    source_file: it.source_file,
    score: it._score,
    likely_causes: (it.likely_causes || []).slice(0, 5),
    checks: (it.checks || []).slice(0, 6),
    fixes: (it.fixes || []).slice(0, 6),
    severity: it.severity,
    urgency: it.urgency,
    notes: it.notes,
  }));
}

// =========================
// Diagnose Handler
// =========================
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Only POST allowed" });
    }

    const { message, preferredLanguage } = req.body || {};
    const userText = (message || "").toString();

    if (!userText.trim()) {
      return res.status(400).json({ error: "Message is required" });
    }

    const lang = preferredLanguage || detectLanguage(userText);

    // ✅ Ultra-short greeting (NO intro, NO lists, NO diagnosis)
    if (isGreetingOnly(userText)) {
      const greetingPrompt = `
Reply in the user's language (${lang}).

User message: "${userText}"

Rules:
- Reply with ONLY one short sentence (max 12 words).
- Do NOT introduce yourself. Do NOT say "I am FixLens".
- Do NOT use numbered lists.
- Ask one simple question meaning: "How can I help you today?" in that language.
- Output ONLY the final message text.
`;

      const g = await client.chat.completions.create({
        model: process.env.FIXLENS_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        messages: [{ role: "user", content: greetingPrompt }],
      });

      const reply = (g.choices?.[0]?.message?.content || "").trim();
      return res.status(200).json({ reply, language: lang });
    }

    // AutoKnowledge from all files in /data
    const matches = findRelevantIssues(userText, 8);

    // If message is too vague, push pro-questions
    const tooVague =
      userText.trim().length < 18 &&
      matches.length === 0 &&
      !/[0-9]/.test(userText);

    const prompt = `
You are a professional automotive diagnostic assistant for technicians.
Respond in the user's language (${lang}).
Be realistic, concise, and technical.

User message:
${userText}

Relevant issues from internal knowledge base (matched from data/*.json):
${JSON.stringify(matches, null, 2)}

Output format (keep it compact):
- Title (1 line)
- Likely causes (ranked, 3-6 bullets max)
- Next checks (3-6 bullets max)
- Ask 3-5 essential questions to continue (vehicle details + symptoms)

Rules:
- Do NOT exaggerate.
- Do NOT say "I am FixLens".
- If info is missing, ask for: year/make/model/engine, mileage, codes, when it happens, and any warning lights.
- If this could be unsafe (brakes, overheating, fuel leak), add a short safety note (1 line max).
${tooVague ? "- User input seems vague: focus more on questions than conclusions.\n" : ""}
`;

    const ai = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o-mini",
      temperature: 0.25,
      messages: [{ role: "user", content: prompt }],
    });

    const reply = (ai.choices?.[0]?.message?.content || "").trim();
    return res.status(200).json({
      reply,
      language: lang,
      matches_count: matches.length,
    });
  } catch (err) {
    console.error("diagnose.js error:", err);
    return res.status(500).json({
      error: "Diagnosis failed",
      details: err?.message || String(err),
    });
  }
}
