// api/audio-diagnose.js
import OpenAI, { toFile } from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===================== Helpers =====================

// تخمين اللغة من النص إذا ما جاء شيء من التطبيق
function guessLanguage(text) {
  if (!text || !text.trim()) return "en";
  const t = text.trim();

  // Arabic
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  // Russian
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Greek
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  // CJK
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\u1100-\u11FF]/.test(t)) return "ko";

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

// برومبت عام لFixLens
const BASE_SYSTEM_PROMPT = `
You are **FixLens Auto**, an intelligent automotive diagnosis assistant.

You ONLY talk about vehicles (cars, SUVs, trucks, vans).
You NEVER talk about home appliances or non-vehicle devices.

You receive:
- A voice recording of a car-related sound (engine, belt, brakes, etc.).
- A short transcription of what the user said (if any).
- Optional extra text notes.
- Optional matched issues from auto_common_issues.json.

Your job:
1. LISTEN carefully to the audio: focus on the pattern of the sound (knocking, ticking, squealing, grinding, whining, etc.).
2. Combine what you hear + any transcript text + JSON hints.
3. Produce a clear diagnostic explanation.

Always be honest about uncertainty.

Your reply MUST follow this markdown structure:

**Quick Summary:**
- ...

**What the Sound Feels Like:**
- (e.g. "metallic knocking that follows engine speed", "high-pitched squeal on rotation", etc.)

**Most Likely Causes:**
1. ...
2. ...

**What You Can Check Now:**
- ...

**Safety / When to Stop Driving:**
- ...

**Next Professional Step:**
- ...

If the audio is too noisy or unclear, say so and ask the user for another recording or a text description instead of guessing.
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
      language: clientLanguage, // من Flutter (مثل "ar" أو "en")
      note,
    } = body;

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res.status(400).json({
        error: "Missing 'audioBase64' field (base64 string).",
      });
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");

    // 🔹 نستخدم Whisper فقط للحصول على أي كلام مسموع (لو المستخدم يتكلم)
    const file = await toFile(audioBuffer, "recording.m4a", {
      type: mimeType || "audio/m4a",
    });

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

    // 🔹 نجرب نجيب قضايا قريبة من الـ knowledge base
    let matchedIssues = [];
    try {
      matchedIssues = await findRelevantIssues(
        transcriptText || note || ""
      );
    } catch (e) {
      console.warn("findRelevantIssues failed:", e);
    }

    const issuesJson =
      matchedIssues && matchedIssues.length
        ? JSON.stringify(matchedIssues, null, 2)
        : "[]";

    // 🔹 الـ bundle النصي اللي يروح للموديل مع الصوت
    const userBundle = `
Transcription of the voice (if any words were detected):
"""
${transcriptText || "N/A"}
"""

User note (if any text was provided in the app):
"""
${note || "N/A"}
"""

Matched issues from auto_common_issues.json:
${issuesJson}

User language code (for your reply): ${finalLanguage}
`;

    // 🔥 هنا السحر: نرسل الصوت نفسه + النص للموديل
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: BASE_SYSTEM_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              audio: {
                data: audioBase64,
                format: (mimeType && mimeType.split("/").pop()) || "m4a",
              },
            },
            {
              type: "input_text",
              text: userBundle,
            },
          ],
        },
      ],
    });

    let replyText = extractTextFromResponse(response);

    if (!replyText) {
      replyText =
        finalLanguage === "ar"
          ? "استلمت التسجيل الصوتي لكن لم أستطع تحليل الصوت بشكل واضح. رجاءً أعد التسجيل في مكان أكثر هدوءاً أو أضف وصفاً مكتوباً للمشكلة في السيارة."
          : "I received the voice note but couldn't clearly analyze the sound. Please try again in a quieter environment or add a short written description of the problem.";
    }

    return res.status(200).json({
      reply: replyText,
      language: finalLanguage,
      transcript: transcriptText,
      issues: matchedIssues || [],
      source: "fixlens-audio-waveform",
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
