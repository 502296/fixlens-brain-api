// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// -------- Language Detection ----------
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u0370-\u03FF]/.test(t)) return "el";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";

  const lower = t.toLowerCase();

  if (/[ñáéíóúü]|hola\b|gracias\b/.test(lower)) return "es";
  if (/[àâçéèêëîïôùûüÿœ]|bonjour\b|merci\b/.test(lower)) return "fr";
  if (/[äöüß]|hallo\b|danke\b/.test(lower)) return "de";

  if (/^[\x00-\x7F]+$/.test(t)) return "en";

  return null;
}

// -------- Safe Logging --------
async function safeLogFixLensEvent(payload) {
  try {
    const mod = await import("../lib/supabaseClient.js");
    const fn = mod.logFixLensEvent;
    if (typeof fn === "function") await fn(payload);
  } catch (_) {}
}

// -------- Handler --------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ code: 405, message: "Method not allowed" });
  }

  const started = Date.now();
  const mode = "image";

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const imageBase64 = body?.imageBase64;
    const userNote = body?.note || body?.userText || "";
    const languageHint = body?.language || "auto";

    if (!imageBase64) {
      return res.status(400).json({
        code: 400,
        message: "imageBase64 is required."
      });
    }

    // -------- Knowledge Base Lookup --------
    let autoKnowledge = null;
    if (userNote?.trim()) {
      try {
        const issues = await findRelevantIssues(userNote);
        if (issues?.length > 0) autoKnowledge = JSON.stringify(issues, null, 2);
      } catch (_) {}
    }

    // -------- Decide Language --------
    let targetLanguage =
      languageHint !== "auto" ? languageHint : guessLanguage(userNote) || "en";

    const languageInstruction =
      targetLanguage === "en"
        ? "Reply in natural English unless the user clearly writes another language."
        : `Reply strictly in this language: ${targetLanguage}.`;

    // -------- System Prompt --------
    const systemPrompt = `
You are FixLens Brain — a world-class multilingual diagnostic assistant for cars, appliances, and all mechanical issues.

LANGUAGE RULE:
- ${languageInstruction}

INSTRUCTIONS:
1. Describe visually what you see in the image.
2. Then give structured analysis:
   - Quick Summary
   - Most Likely Causes
   - What You Can Check Now
   - Safety Warnings
   - Professional Next Step
3. If user note exists, use it.
4. ALWAYS give clear and helpful advice.
${autoKnowledge ? "\nKnowledge Base:\n" + autoKnowledge : ""}
    `.trim();

    const userText = userNote?.trim()
      ? userNote
      : "Please analyze this image and explain any potential issues.";

    // -------- Correct OpenAI Responses API Call (Fixed!) --------
    const result = await openai.responses.create({
      model: "gpt-4.1-mini",
      max_output_tokens: 900,
      input: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "input_text", text: userText },
            { type: "input_image", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }
      ]
    });

    const reply = result?.output_text?.trim() || "I could not analyze the image.";

    // -------- Log Event --------
    const latencyMs = Date.now() - started;
    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      userMessage: userNote || "[image only]",
      aiReply: reply,
      meta: {
        endpoint: "/api/image-diagnose",
        model: "gpt-4.1-mini",
        targetLanguage,
        latencyMs,
        success: true
      }
    });

    return res.status(200).json({
      code: 200,
      message: "OK",
      reply,
      language: targetLanguage
    });

  } catch (err) {
    console.error("FixLens image-diagnose error:", err);

    const latencyMs = Date.now() - started;
    safeLogFixLensEvent({
      source: "mobile-app",
      mode,
      meta: {
        endpoint: "/api/image-diagnose",
        error: String(err),
        latencyMs,
        success: false
      }
    });

    return res.status(500).json({
      code: 500,
      message: "A server error has occurred"
    });
  }
}
