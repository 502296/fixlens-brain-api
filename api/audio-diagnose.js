// api/audio-diagnose.js
import OpenAI, { toFile } from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===================== Helpers =====================

// تخمين اللغة من النص
function guessLanguage(text) {
  if (!text || !text.trim()) return "en";
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Russian
  if (/[\u0370-\u03FF]/.test(t)) return "el"; // Greek
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh"; // Chinese
  if (/[\u3040-\u30FF]/.test(t)) return "ja"; // Japanese
  if (/[\u1100-\u11FF]/.test(t)) return "ko"; // Korean

  return "en";
}

// هل الترانسكربت فعلاً يشبه وصف مشكلة سيارة؟
function looksLikeCarDescription(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();

  const words = t.split(/\s+/).filter((w) => /[a-z\u0600-\u06FF]/i.test(w));
  if (words.length < 3) return false;

  const carWords = [
    "engine",
    "motor",
    "car",
    "vehicle",
    "noise",
    "sound",
    "knock",
    "rattle",
    "click",
    "tapping",
    "vibration",
    "shake",
    "brake",
    "brakes",
    "belt",
    "timing",
    "chain",
    "transmission",
    "gear",
    "start",
    "starting",
    "idle",
    "rpm",
    "exhaust",
    "smoke",
    "leak",
    "oil",
    "coolant",
    "overheat",
    "overheating",

    "محرك",
    "المحرك",
    "سيارة",
    "السيارة",
    "صوت",
    "ضجيج",
    "طرق",
    "طقطقة",
    "رجة",
    "رجه",
    "اهتزاز",
    "فرامل",
    "بنزين",
    "ديزل",
    "دخان",
    "تهريب",
    "زيت",
    "ماء",
    "حرارة",
    "قير",
    "جير",
  ];

  const hasCarWord = carWords.some((w) => t.includes(w));
  return hasCarWord;
}

// برومبت FixLens
const BASE_SYSTEM_PROMPT = `
You are **FixLens Auto**, an intelligent automotive diagnosis assistant.
You ONLY talk about vehicles (cars, SUVs, trucks, vans).

You receive:
- A short transcription of what the user said in a voice note (any language).
- Optional extra notes.
- Optional relevant issues JSON from auto_common_issues.json.

Your job:
1. Understand the symptoms (noises, vibrations, leaks, warning lights, smells, performance issues, starting problems, etc.).
2. Combine transcription + notes + JSON hints to produce a clear, honest diagnosis.

Always answer in the **same language as the user** if possible.

Your reply MUST follow this markdown structure:

**Quick Summary:**
- ...

**Most Likely Causes:**
1. ...
2. ...

**What You Can Check Now:**
- ...

**Safety / When to Stop Driving:**
- ...

**Next Professional Step:**
- ...

If information is not enough, say so and ask for more details instead of guessing.
`;

// استخراج النص من Responses API
function extractTextFromResponse(resp) {
  try {
    const first = resp.output?.[0];
    if (!first || !first.content) return null;
    const textPart = first.content.find((c) => c.type === "output_text");
    if (textPart && textPart.text) return textPart.text.toString();
  } catch (e) {
    console.error("Failed to extract text from OpenAI response:", e);
  }
  return null;
}

// ===================== Handler =====================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res
      .status(405)
      .json({ error: "Method not allowed. Use POST." });
  }

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const {
      audioBase64,
      mimeType,
      language: clientLanguage, // من Flutter
      note,
    } = body;

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({
        error: "Missing 'audioBase64' field (base64 string).",
      });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // نحول base64 إلى ملف باستخدام toFile (الطريقة الصحيحة مع openai-node)
    const file = await toFile(audioBuffer, "recording.m4a", {
      type: mimeType || "audio/m4a",
    });

    // 1) Transcription باستخدام Whisper
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      ...(clientLanguage &&
      clientLanguage !== "auto" &&
      typeof clientLanguage === "string"
        ? { language: clientLanguage }
        : {}),
    });

    const transcriptText = (transcription.text || "").trim();
    console.log("FixLens audio transcript:", transcriptText);

    let finalLanguage =
      clientLanguage && clientLanguage !== "auto"
        ? clientLanguage
        : guessLanguage(transcriptText || note || "");

    // لو الترانسكربت لا يشبه وصف مشكلة سيارة → لا نشخّص
    if (!looksLikeCarDescription(transcriptText)) {
      const politeReply =
        finalLanguage === "ar"
          ? `استلمت التسجيل الصوتي، لكن يبدو أنه يحتوي على صوت محرك أو ضوضاء عامة بدون وصف واضح للمشكلة بالكلام.

حتى أستطيع أن أساعدك بدقة وأعطيك تشخيصًا مفيدًا، أرجو منك أحد الخيارين:
1. تسجيل مقطع صوتي جديد تشرح فيه *بالكلام* ما الذي يحدث في السيارة (مثلاً: "يوجد صوت طقطقة من جهة المحرك عند التشغيل وهو بارد"، أو "السيارة تهتز عندما أتوقف عند الإشارة").
2. أو كتابة وصف قصير للمشكلة في خانة النص.

كلما كان الوصف أوضح، استطعتُ أن أحدد الأسباب المحتملة وخطوات الفحص بشكل أفضل. 🚗🔍`
          : `I received your voice note, but it sounds more like general engine noise without enough spoken description of the problem.

To give you an accurate diagnosis, please either:
1. Record a new voice note where you *describe the issue in words* (for example: "there is a rattling noise from the engine on cold start", or "the car vibrates when I stop at a red light"),  
2. Or type a short description of the problem in the text box.

The clearer your description, the better I can suggest likely causes and next steps. 🚗🔍`;

      return res.status(200).json({
        reply: politeReply,
        language: finalLanguage,
        transcript: transcriptText,
      });
    }

    // 2) نجلب المشاكل القريبة من auto_common_issues.json
    let matchedIssues = [];
    try {
      matchedIssues = await findRelevantIssues(transcriptText);
    } catch (e) {
      console.warn("findRelevantIssues failed:", e);
    }

    const issuesJson =
      matchedIssues && matchedIssues.length
        ? JSON.stringify(matchedIssues, null, 2)
        : "[]";

    const userBundle = `
Voice transcription:
"""
${transcriptText}
"""

User note (if any):
"""
${note || "N/A"}
"""

Matched issues from auto_common_issues.json:
${issuesJson}

Please respond in language: ${finalLanguage}
`;

    // 3) تحليل نهائي عن طريق Responses API
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: BASE_SYSTEM_PROMPT }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: userBundle }],
        },
      ],
    });

    const replyText =
      extractTextFromResponse(response) ||
      (finalLanguage === "ar"
        ? "حدث خطأ غير متوقع أثناء تحليل الصوت. من فضلك حاول مرة أخرى لاحقاً أو أرسل وصفاً مكتوباً للمشكلة."
        : "An unexpected error occurred while analyzing the audio. Please try again later or send a written description of the problem.");

    return res.status(200).json({
      reply: replyText,
      language: finalLanguage,
      transcript: transcriptText,
    });
  } catch (err) {
    console.error("FixLens audio diagnose error:", err);

    const details =
      err?.response?.data ||
      err?.body ||
      err?.message ||
      "Unknown error in audio-diagnose API.";

    return res.status(500).json({
      error: "Audio diagnosis failed",
      details,
    });
  }
}
