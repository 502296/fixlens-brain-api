// service.js — FixLens Brain (FINAL PRO, SAFE, MULTI-MODAL)

import OpenAI from "openai";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function safeString(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  return String(locale || "en").split("-")[0].toLowerCase();
}

/**
 * Main handler
 */
export async function handleFixLensRequest(req, res) {
  try {
    const body = req.body || {};

    const locale = normalizeLocale(body.locale);
    const text = safeString(body.text);
    const history = Array.isArray(body.history) ? body.history : [];
    const images = Array.isArray(body.images) ? body.images : [];
    const audio = body.audio || null;

    // Build system prompt (FixLens Doctor)
    const systemPrompt = buildDoctorMessages();

    // Build messages
    const messages = [{ role: "system", content: systemPrompt }];

    // Conversation history (important!)
    for (const msg of history) {
      if (msg?.role && msg?.content) {
        messages.push({
          role: msg.role,
          content: safeString(msg.content),
        });
      }
    }

    // Knowledge snippets (optional but safe)
    try {
      const knowledge = await buildKnowledgeSnippets(text);
      if (knowledge) {
        messages.push({
          role: "system",
          content: knowledge,
        });
      }
    } catch (e) {
      console.warn("Knowledge skipped:", e.message);
    }

    // User input block
    const userParts = [];

    if (text) {
      userParts.push({ type: "text", text });
    }

    if (images.length) {
      for (const img of images) {
        if (img?.url) {
          userParts.push({
            type: "image_url",
            image_url: { url: img.url },
          });
        }
      }
    }

    if (userParts.length) {
      messages.push({
        role: "user",
        content: userParts,
      });
    }

    // =========================
    // TEXT + IMAGE RESPONSE
    // =========================
    let assistantText = "";

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.3,
      max_tokens: 700,
    });

    assistantText =
      response?.choices?.[0]?.message?.content ||
      "I couldn’t analyze this request. Please try again.";

    // =========================
    // AUDIO (Whisper)
    // =========================
    if (audio?.base64) {
      try {
        const audioBuffer = Buffer.from(audio.base64, "base64");

        const transcript = await client.audio.transcriptions.create({
          file: audioBuffer,
          model: "gpt-4o-transcribe",
          language: locale,
        });

        if (transcript?.text) {
          assistantText =
            assistantText +
            "\n\n" +
            (locale === "ar"
              ? "📌 ملاحظة من الصوت:\n"
              : "📌 From your voice note:\n") +
            transcript.text;
        }
      } catch (e) {
        console.warn("Audio skipped:", e.message);
      }
    }

    // =========================
    // FINAL SAFE RESPONSE
    // =========================
    return res.status(200).json({
      ok: true,
      reply: assistantText,
      language: locale,
    });
  } catch (err) {
    console.error("FixLens fatal error:", err);
    return res.status(200).json({
      ok: false,
      reply:
        "Something went wrong while analyzing. Please try again in a moment.",
    });
  }
}
