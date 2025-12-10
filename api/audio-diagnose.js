// api/audio-diagnose.js
import OpenAI, { toFile } from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة تخمين اللغة التي استخدمناها في image-diagnose
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

// 🧠 برومبت عام لتحليل مشاكل السيارات
const BASE_SYSTEM_PROMPT = `
You are **FixLens Auto**, an intelligent automotive diagnosis assistant.
You receive:
- A short **transcription of what the user said in the voice note** (could be any language).
- Optional **notes** from the user.
- Optional **matched common issues JSON** from auto_common_issues.json.

Your job:
1. Understand the described symptoms (noises, vibrations, leaks, warning lights, smells, performance issues, starting problems, etc.).
2. Combine:
   - The voice transcription,
   - Any extra user notes,
   - And the relevant issues JSON (if provided)
   to produce a high-quality, structured answer for a car owner or mechanic.

Always answer in the **same language as the user** (if it seems Arabic, answer Arabic; if English, answer English, etc.).

Your reply MUST follow this structure (markdown):

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

If information is not enough, be honest and politely ask for more details instead of guessing blindly.
`;

// دالة صغيرة لاستخراج النص من response من نوع OpenAI Responses API
function extractTextFromResponse(resp) {
  try {
    const first = resp.output?.[0];
    if (!first || !first.content) return null;

    const textPart = first.content.find((c) => c.type === "output_text");
    if (textPart && textPart.text) return textPart.text.toString();

    // fallback قديم
    if (typeof first.output_text === "string") return first.output_text;
  } catch (e) {
    console.error("Failed to extract text from OpenAI response:", e);
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 📨 نقرأ الجسم (JSON) من Flutter
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const {
      audioBase64,
      mimeType,
      language: preferredLanguage, // "auto" أو "en" أو "ar" ...
      note, // ملاحظة إضافية من المستخدم (اختياري)
      mode, // متروك للمستقبل
    } = body;

    if (!audioBase64) {
      return res
        .status(400)
        .json({ error: "Missing 'audioBase64' in request body." });
    }

    // 🧊 نحول الـ base64 إلى Buffer
    const audioBuffer = Buffer.from(audioBase64, "base64");

    // نخبر toFile باسم و نوع الملف (Whisper يدعم m4a, mp3, mp4, wav, webm, ogg, mpeg, mpga ...)
    const file = await toFile(
      audioBuffer,
      "recording.m4a", // الاسم فقط – الامتداد لأغراض التوافق
      {
        type: mimeType || "audio/m4a",
      }
    );

    // 🎧 أولاً: نعمل Transcription باستخدام Whisper
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file,
      // إذا المستخدم حدّد اللغة يدويًا غير "auto" نمررها، غير ذلك نخلي Whisper يكتشف
      ...(preferredLanguage &&
      preferredLanguage !== "auto" &&
      typeof preferredLanguage === "string"
        ? { language: preferredLanguage }
        : {}),
    });

    const transcriptText = (transcription.text || "").trim();
    console.log("FixLens audio transcript:", transcriptText);

    // نحدد لغة الرد
    let finalLanguage =
      preferredLanguage && preferredLanguage !== "auto"
        ? preferredLanguage
        : guessLanguage(transcriptText || note || "");

    // 🧩 إذا لم يوجد كلام واضح في التسجيل (فقط ضوضاء / محرك)، نرد برد خاص محترم
    if (!transcriptText || transcriptText.length < 5) {
      const politeReply =
        finalLanguage === "ar"
          ? `يبدو أن التسجيل الصوتي يحتوي على أصوات عامة (مثل صوت محرك أو ضوضاء) بدون كلام واضح يمكنني فهمه.

حتى أستطيع مساعدتك بدقة، أرجو منك واحد من الخيارين:
1. تسجيل مقطع جديد تشرح فيه بصوتك ما هي المشكلة (مثل: "يوجد صوت طقطقة عند تشغيل المحرك وهو بارد"، أو "السيارة تهتز عندما أتوقف عند الإشارة").
2. أو كتابة وصف قصير للمشكلة في خانة النص.

كلما كان الوصف أدق، استطعت أن أقدّم لك تشخيصًا أدق وخطوات عملية لما يمكنك فحصه أو مناقشته مع الميكانيكي. 🚗🔍`
          : `It seems that the voice note contains general sound (engine/noise) but no clear speech that I can understand.

To help you accurately, please either:
1. Record a new voice note where you *describe the problem in words* (for example: "there is a rattling noise on cold start" or "the car vibrates when I stop at a light"),  
2. Or type a short description of the problem in the text box.

The more details you share, the better I can guide you with likely causes and next steps. 🚗🔍`;

      return res.status(200).json({
        reply: politeReply,
        language: finalLanguage,
        transcript: transcriptText,
      });
    }

    // 🔍 نجلب المشاكل القريبة من auto_common_issues.json
    let matchedIssues = [];
    try {
      matchedIssues = await findRelevantIssues(transcriptText);
    } catch (e) {
      console.warn("findRelevantIssues failed:", e);
    }

    // نجهز نص JSON للمشاكل (إن وجد)
    const issuesJson =
      matchedIssues && matchedIssues.length
        ? JSON.stringify(matchedIssues, null, 2)
        : "[]";

    // 🧾 نبني رسالة المستخدم التي نرسلها لـ GPT
    const userBundle = `
Voice transcription (what the user said, any language):
"""
${transcriptText}
"""

Additional note from user (if any):
"""
${note || "N/A"}
"""

Matched issues from auto_common_issues.json:
${issuesJson}

Please respond in the same language as the user (detected: ${finalLanguage}).
`;

    // 🤖 نستدعي Responses API لتحليل المشكلة وإرجاع الرد المنسق
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
              type: "input_text",
              text: userBundle,
            },
          ],
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

    // نحاول استخراج تفاصيل مفيدة من الخطأ
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
