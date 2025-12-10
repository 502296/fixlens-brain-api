// api/audio-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function detectLanguageHint(lang) {
  if (!lang || lang === "auto") {
    return (
      "Reply in the same language detected from the audio if possible; " +
      "otherwise use clear, friendly English."
    );
  }

  if (lang === "ar") {
    return "أجب باللغة العربية قدر الإمكان وبأسلوب واضح وبسيط.";
  }

  if (lang === "en") {
    return "Answer in clear, friendly English.";
  }

  return (
    "Reply in the user's language if you can detect it from the audio; " +
    "otherwise use clear English."
  );
}

function mapMimeToFormat(mimeType) {
  if (!mimeType) return "wav";

  const lower = mimeType.toLowerCase();

  if (lower.includes("wav")) return "wav";
  if (lower.includes("mp3")) return "mp3";
  if (lower.includes("m4a") || lower.includes("mp4")) return "mp4";
  if (lower.includes("aac")) return "aac";
  if (lower.includes("ogg")) return "ogg";

  // قيمة افتراضية آمنة
  return "wav";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      audioBase64,
      mimeType = "audio/m4a",
      language = "auto",
      note,
    } = req.body || {};

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'audioBase64' (base64 audio data)." });
    }

    const audioFormat = mapMimeToFormat(mimeType);
    const langHint = detectLanguageHint(language);

    // 🧠 نستخدم نموذج audio-preview حتى يسمع التسجيل مباشرة
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      messages: [
        {
          role: "system",
          content:
            "You are FixLens Auto, a professional automotive diagnostics assistant. " +
            "You listen carefully to car and mechanical sounds (engine, exhaust, suspension, brakes, belts, pulleys, etc.) " +
            "and infer the most likely mechanical issues. " +
            "Be practical, avoid guessing wildly, and always include safety advice.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Listen carefully to this recording of a vehicle or engine sound. " +
                "Your task:\n" +
                "1) Briefly describe the sound in words (location, rhythm, tone, when it might happen).\n" +
                "2) Infer the most likely mechanical causes.\n" +
                "3) Suggest what the driver can check now.\n" +
                "4) Add safety warnings (when to stop driving).\n" +
                "5) Suggest the next professional step.\n\n" +
                (note
                  ? `Extra note from the user: ${note}\n\n`
                  : "") +
                langHint +
                "\n\nFormat your answer using these sections in markdown:\n" +
                "**Quick Summary:**\n" +
                "**Most Likely Causes:** (numbered list)\n" +
                "**What You Can Check Now:**\n" +
                "**Safety / When to Stop Driving:**\n" +
                "**Next Professional Step:**",
            },
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: audioFormat,
              },
            },
          ],
        },
      ],
    });

    let reply = completion.choices[0]?.message?.content?.toString() ?? "";

    // 🔍 (اختياري) نحاول استخدام autoKnowledge إذا قدرنا نستخرج وصفًا من الرد
    // هنا نأخذ أول فقرة بعد "Quick Summary" ونمررها إلى findRelevantIssues
    try {
      const summaryMatch = reply.split("**Quick Summary:**")[1];
      if (summaryMatch) {
        const firstLine = summaryMatch.trim().split("\n")[0];
        const extra = await findRelevantIssues(firstLine, language);
        if (extra && extra.trim()) {
          reply +=
            "\n\n---\n\n" +
            (language === "ar"
              ? "معلومات إضافية من قاعدة معرفة FixLens:\n"
              : "Extra tips from FixLens knowledge base:\n") +
            extra;
        }
      }
    } catch (e) {
      console.warn("autoKnowledge extra hint failed:", e);
    }

    return res.status(200).json({
      reply,
      language,
    });
  } catch (err) {
    console.error("FixLens audio-diagnose error:", err);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: err?.message ?? String(err),
    });
  }
}
