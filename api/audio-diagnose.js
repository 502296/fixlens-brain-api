// api/audio-diagnose.js
// FixLens Sound Lab – Stable JSON audio pipeline
// Flutter -> JSON (audioBase64) -> Transcribe -> Diagnose

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ------- Helpers --------
function cleanText(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
}

function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  if (/[\u0600-\u06FF]/.test(t)) return "ar"; // Arabic
  if (/[\u0400-\u04FF]/.test(t)) return "ru"; // Russian
  if (/[áéíóúñüÁÉÍÓÚÑÜ]/.test(t)) return "es"; // Spanish-ish
  if (/[äöüßÄÖÜ]/.test(t)) return "de"; // German-ish
  if (/[àâçéèêëîïôûùüÿÀÂÇÉÈÊËÎÏÔÛÙÜŸ]/.test(t)) return "fr"; // French-ish

  return "en";
}

function guessExtFromMime(mimeType) {
  const m = (mimeType || "").toLowerCase();
  if (m.includes("wav")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("webm")) return "webm";
  return "m4a"; // flutter_record غالباً
}

// ------- Main handler --------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  try {
    let body = req.body;

    // في بعض بيئات Vercel يكون body = string
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }

    const audioBase64 =
      body?.audioBase64 || body?.audio || body?.file || "";
    const mimeType = body?.mimeType || "audio/m4a";
    const preferredLanguage = body?.language || body?.preferredLanguage || "auto";

    if (!audioBase64 || typeof audioBase64 !== "string") {
      return res
        .status(400)
        .json({ error: "Missing 'audioBase64' in request body." });
    }

    // ---- 1) Decode base64 -> Buffer ----
    let audioBuffer;
    try {
      audioBuffer = Buffer.from(audioBase64, "base64");
      if (!audioBuffer.length) {
        throw new Error("Empty audio buffer");
      }
    } catch (e) {
      console.error("Base64 decode error:", e);
      return res.status(400).json({
        error: "Invalid audioBase64 data",
        details: e.message || String(e),
      });
    }

    // ---- 2) Transcribe with gpt-4o-mini-transcribe ----
    let transcriptText = "";
    const ext = guessExtFromMime(mimeType);

    try {
      const transcription = await openai.audio.transcriptions.create({
        file: {
          data: audioBuffer,
          name: `fixlens-audio.${ext}`,
        },
        model: "gpt-4o-mini-transcribe",
        // نمرّر اللغة لو المستخدم محددها، غير ضروري لكن يساعد أحياناً
        language:
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage
            : undefined,
        response_format: "json",
      });

      transcriptText = cleanText(transcription.text);
      console.log("FixLens transcript:", transcriptText);
    } catch (e) {
      console.error("Transcription error:", e);
      return res.status(500).json({
        error: "Audio diagnosis failed",
        details:
          e?.response?.data ||
          e?.message ||
          "Failed to transcribe the audio.",
      });
    }

    if (!transcriptText) {
      const langForEmpty =
        preferredLanguage && preferredLanguage !== "auto"
          ? preferredLanguage
          : "en";

      return res.status(200).json({
        reply:
          langForEmpty === "ar"
            ? "لم أتمكّن من التقاط صوت ميكانيكي واضح من هذا التسجيل. جرّب تسجيل ١٠–١٥ ثانية قريبة من مصدر الصوت، مع تقليل ضوضاء الهواء أو الكلام قدر الإمكان."
            : "I couldn’t detect a clear mechanical sound from this recording. Please record 10–15 seconds close to the source of the noise, avoiding wind or speech as much as possible.",
        language: langForEmpty,
      });
    }

    // ---- 3) Analyze using GPT-5.1-mini ----
    try {
      const resolvedLanguage =
        (preferredLanguage && preferredLanguage !== "auto" && preferredLanguage) ||
        guessLanguage(transcriptText) ||
        "en";

      const systemPrompt = `
You are **FixLens Auto – Sound Lab**, a careful AI mechanic that analyzes car problems
based on what the driver recorded and what was transcribed from the audio.

The transcription includes the driver's spoken description of the sound and any context
about when it happens (RPM, speed, braking, turning, bumps, etc.).

Your job:
1. Extract all details related to the sound pattern and when it happens.
2. Map those patterns to mechanical causes:
   - engine top-end (lifters/valvetrain)
   - engine bottom-end (rods/bearings)
   - ignition/misfire
   - timing chain/belt
   - accessory belt/tensioner/pulleys
   - exhaust leaks / rattling heat shields
   - wheel bearings, CV joints, suspension
   - brakes (pads, rotors, calipers)
   - drivetrain and mounts
3. Provide a ranked list of likely causes with approximate probabilities (that roughly sum to 1.0).
4. Assess risk level for driving:
   - CRITICAL – Stop driving immediately.
   - HIGH – Drive only gently and visit a mechanic ASAP.
   - MEDIUM – Schedule a shop visit soon.
   - LOW – Probably minor, but worth checking.
5. Give simple, practical next steps for the driver.

LANGUAGE:
- The driver's language code is: "${resolvedLanguage}".
- ALWAYS respond ONLY in this language.
- Tone: calm, friendly, like an experienced mechanic explaining to a normal driver.

If the transcription is mostly unrelated conversation and you cannot infer a clear car sound context,
say you are not confident and explain how to record a better sample.
      `.trim();

      const combinedPrompt = `
System instructions:
${systemPrompt}

Transcribed audio from the driver:
${transcriptText}
      `.trim();

      const response = await openai.responses.create({
        model: "gpt-5.1-mini",
        input: combinedPrompt,
        max_output_tokens: 900,
      });

      const replyText = cleanText(response.output_text);

      return res.status(200).json({
        reply:
          replyText ||
          (resolvedLanguage === "ar"
            ? "لم أتمكّن من تشخيص المشكلة بدقة من هذا التسجيل. حاول تسجيل صوت أوضح قريب من مصدر الصوت، مع ذكر متى يظهر (السرعة، الضغط على الفرامل، لفّ المقود، إلخ)."
            : "I couldn’t confidently diagnose from this recording. Please try again with a clearer sample near the source of the noise and mention when it happens (speed, braking, turning, etc.)."),
        language: resolvedLanguage,
      });
    } catch (e) {
      console.error("FixLens Sound Lab analysis error:", e);
      return res.status(500).json({
        error: "Audio diagnosis failed",
        details:
          e?.response?.data ||
          e?.message ||
          "Failed to analyze the transcribed audio.",
      });
    }
  } catch (e) {
    console.error("Unexpected audio handler error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message || String(e),
    });
  }
}
