// api/diagnose.js
// FixLens – TEXT DIAGNOSIS (Global, multi-language)

import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper: clean text
function cleanText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

// Helper: safe logging to Supabase (doesn't break API if logging fails)
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
    return res
      .status(405)
      .json({ code: 405, message: "Method not allowed. Use POST." });
  }

  const started = Date.now();
  const mode = "text";

  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string if JSON.parse fails
      }
    }

    const message = cleanText(body?.message || body?.text || body?.prompt);
    const languageHint = cleanText(body?.languageHint || body?.lang);

    if (!message) {
      return res
        .status(400)
        .json({ code: 400, message: "message is required in request body." });
    }

    // Load knowledge base
    let issuesSummary = "No matched issues from the knowledge base.";
    try {
      const issues = await findRelevantIssues(message);
      if (issues && issues.length > 0) {
        issuesSummary = JSON.stringify(issues, null, 2);
      }
    } catch (err) {
      console.error("autoKnowledge error:", err);
      issuesSummary = "Knowledge base unavailable (internal error).";
    }

    const systemPrompt = `
You are FixLens Auto, a global intelligent automotive assistant.

- Detect the user's language automatically and ALWAYS reply in the same language
  (Arabic if the user writes in Arabic, Spanish for Spanish, etc.).
- You specialize in car problems: noises, leaks, warning lights, vibrations, smells,
  starting issues, rough idle, shaking, braking issues, steering, and other common symptoms.
- Use the "reference issues" below only as internal hints. Don't show raw JSON to the user.
- Your answer must be friendly, clear, and not scary, but honest about safety.

Your reply structure:
1) Short friendly greeting in the user's language.
2) Brief summary of what might be happening (1–3 sentences).
3) 2–4 likely causes with simple explanations (bullet points).
4) 3–5 practical next steps (what the driver should check, how urgent it is,
   and whether it's safe to drive or should tow the car).
5) Always add a short safety note: this is not a replacement for an in-person mechanic.

If the user message is just "hello" or something very short with no symptoms,
gently introduce yourself, explain what FixLens can do, and ask them to describe the issue.

If the user is NOT talking about cars at all, give a short polite answer
in their language, and then remind them that FixLens Auto is mainly for cars.
`.trim();

    const combinedPrompt = `
System instructions:
${systemPrompt}

User message:
${message}

Language hint (optional, may be empty):
${languageHint || "none"}

Reference issues from autoKnowledge (for your internal reasoning only):
${issuesSummary}
`.trim();

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: combinedPrompt,
      max_output_tokens: 900,
    });

    const replyText = cleanText(response.output_text);

    // Detect language from reply (simple heuristic)
    let detectedLanguage = languageHint || null;
    if (!detectedLanguage) {
      if (/[\u0600-\u06FF]/.test(replyText)) {
        detectedLanguage = "ar";
      } else if (/[áéíóúñ¿¡]/i.test(replyText)) {
        detectedLanguage = "es";
      } else if (/[а-яё]/i.test(replyText)) {
        detectedLanguage = "ru";
      } else {
        detectedLanguage = "en";
      }
    }

    const latencyMs = Date.now() - started;

    // Log to Supabase (non-blocking)
    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      userMessage: message,
      aiReply: replyText,
      meta: {
        endpoint: "/api/diagnose",
        languageHint,
        detectedLanguage,
        model: "gpt-4.1-mini",
        latencyMs,
        success: true,
      },
    });

    return res.status(200).json({
      code: 200,
      message: "OK",
      reply: replyText || "FixLens Auto could not generate a reply.",
      language: detectedLanguage,
    });
  } catch (err) {
    console.error("FixLens diagnose.js error:", err);

    const latencyMs = Date.now() - started;

    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      userMessage: null,
      aiReply: null,
      meta: {
        endpoint: "/api/diagnose",
        error: String(err?.message || err),
        latencyMs,
        success: false,
      },
    });

    return res.status(500).json({
      code: 500,
      message: "A server error has occurred",
      details:
        process.env.NODE_ENV === "development"
          ? String(err?.stack || err?.message || err)
          : undefined,
    });
  }
}
