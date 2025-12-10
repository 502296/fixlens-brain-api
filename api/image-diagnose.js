// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة تخمين اللغة
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

  const lower = t.toLowerCase();

  if (/[ñáéíóúü]|hola\b|gracias\b|buenos\s+d[ií]as/.test(lower)) return "es";
  if (/[àâçéèêëîïôùûüÿœ]|bonjour\b|merci\b/.test(lower)) return "fr";
  if (/[äöüß]|hallo\b|danke\b/.test(lower)) return "de";

  if (/^[\x00-\x7F]+$/.test(t)) return "en";

  return null;
}

// لوج آمن مع Supabase (نفس أسلوب audio)
async function safeLogFixLensEvent(payload) {
  try {
    const mod = await import("../lib/supabaseClient.js");
    const fn = mod.logFixLensEvent;
    if (typeof fn === "function") {
      await fn(payload);
    } else {
      console.error("logFixLensEvent is not a function (ignored).");
    }
  } catch (e) {
    console.error("Supabase logging error (ignored):", e.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ code: 405, message: "Method not allowed" });
  }

  const started = Date.now();
  const mode = "image";

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const imageBase64 = body.imageBase64;
    const userNote = body.note || body.userText || "";
    const languageHint = body.language || "auto";

    if (!imageBase64) {
      return res
        .status(400)
        .json({ code: 400, message: "imageBase64 is required." });
    }

    // ================= Knowledge Base =================
    let autoKnowledge = null;
    try {
      if (userNote && userNote.trim().length > 0) {
        const issues = await findRelevantIssues(userNote);
        if (issues && issues.length > 0) {
          autoKnowledge = JSON.stringify(issues, null, 2);
        }
      }
    } catch (err) {
      console.error("autoKnowledge (image) error:", err);
    }

    // ================= Language =================
    let targetLanguage = null;
    if (languageHint && languageHint !== "auto") {
      targetLanguage = languageHint;
    } else {
      targetLanguage = guessLanguage(userNote) || "en";
    }

    const languageInstruction =
      targetLanguage === "en"
        ? "Reply in natural English, unless the note is clearly in another language."
        : `Reply strictly in this language: ${targetLanguage}.`;

    // ================= System Prompt =================
    const systemPrompt = `
You are FixLens Brain – a world-class multilingual diagnostic assistant for cars, home appliances, and general mechanical issues.

Language rule:
- ${languageInstruction}
- NEVER switch to another language unless the user clearly switches.
- If there's any Arabic, answer fully in Arabic. If Spanish, answer in Spanish, etc.

General rules:
- You are now analyzing an image related to a possible mechanical/auto issue.
- Describe briefly what you see that is relevant to the problem.
- Then follow the same structure:
  - **Quick Summary**
  - **Most Likely Causes**
  - **What You Can Check Now**
  - **Safety / When to Stop Driving or Using the device**
  - **Next Professional Step**
- If the user note gives extra context, use it.
- Be honest about uncertainty and give safety warnings when needed.
${
  autoKnowledge
    ? "\nInternal hints (from knowledge base):\n" + autoKnowledge
    : ""
}
`.trim();

    const userText =
      userNote && userNote.trim().length > 0
        ? userNote
        : "Please analyze this image and explain any possible issues, in the correct language.";

    // ================= Call OpenAI (chat.completions) =================
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      max_tokens: 900,
      temperature: 0.5,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "input_image",
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
            },
          ],
        },
      ],
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      "I could not analyze the image.";

    const latencyMs = Date.now() - started;

    // ================= Logging =================
    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      userMessage: userNote || "[image only]",
      aiReply: reply,
      meta: {
        endpoint: "/api/image-diagnose",
        languageHint,
        targetLanguage,
        model: "gpt-4.1-mini",
        latencyMs,
        success: true,
      },
    });

    return res.status(200).json({
      code: 200,
      message: "OK",
      reply,
      language: targetLanguage,
    });
  } catch (err) {
    console.error("FixLens Brain image-diagnose error:", err);

    const latencyMs = Date.now() - started;

    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      userMessage: null,
      aiReply: null,
      meta: {
        endpoint: "/api/image-diagnose",
        error: String(err?.message || err),
        latencyMs,
        success: false,
      },
    });

    return res.status(500).json({
      code: 500,
      message: "A server error has occurred",
      // لو حبيت نقدر لاحقاً نرجّع التفاصيل وقت الـ debug فقط
      // details: String(err?.message || err),
    });
  }
}
