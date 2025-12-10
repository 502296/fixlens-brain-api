// api/audio-diagnose.js
import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false,
  },
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// نفس دالة التخمين من ملفاتك الأخرى
function guessLanguage(text) {
  if (!text || !text.trim()) return null;
  const t = text.trim();

  // Arabic
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  // Russian
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  // Spanish-ish
  if (/[áéíóúñüÁÉÍÓÚÑÜ]/.test(t)) return "es";
  // German-ish
  if (/[äöüßÄÖÜ]/.test(t)) return "de";
  // French-ish
  if (/[àâçéèêëîïôûùüÿÀÂÇÉÈÊËÎÏÔÛÙÜŸ]/.test(t)) return "fr";

  return "en";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = formidable({ multiples: false });

    form.parse(req, async (err, fields, files) => {
      if (err) {
        console.error("Form parse error:", err);
        return res.status(400).json({ error: "Invalid form data" });
      }

      const audioFile = Array.isArray(files.audio)
        ? files.audio[0]
        : files.audio;

      if (!audioFile) {
        return res.status(400).json({ error: "No audio file provided" });
      }

      const preferredLanguage =
        (Array.isArray(fields.preferredLanguage)
          ? fields.preferredLanguage[0]
          : fields.preferredLanguage) ||
        req.query.preferredLanguage ||
        "auto";

      const filePath = audioFile.filepath || audioFile.path;

      try {
        // 1) نرفع ملف الصوت إلى OpenAI Files
        // ⚠️ هنا كان الخطأ: سابقاً كانت purpose = "input"
        // الآن نستخدم قيمة صحيحة "user_data"
        const uploadedFile = await openai.files.create({
          file: fs.createReadStream(filePath),
          purpose: "user_data",
        });

        // 2) نطلب من النموذج تحليل الصوت عن طريق Responses API
        const response = await openai.responses.create({
          model:
            process.env.FIXLENS_AUDIO_MODEL ||
            process.env.FIXLENS_MODEL ||
            "gpt-4o-mini",
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: `
You are FixLens Auto, an expert AI assistant for car diagnostics.
You receive an AUDIO recording of a car sound (engine, brakes, suspension, etc.).

Your job:
1. Infer what kind of sound it is (knocking, squeaking, grinding, hissing, etc.).
2. List the most likely causes, from most to least likely.
3. Indicate how urgent the issue is (now, soon, or can wait).
4. Give clear next steps for the driver (what to check, what to tell the mechanic).

LANGUAGE:
- If preferredLanguage is provided, answer in that language.
- If preferredLanguage = "auto", reply in the same language you detect from the driver if possible, otherwise use English.
Keep the tone friendly and clear, like a smart mechanic explaining to a normal driver.
                  `.trim(),
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    preferredLanguage && preferredLanguage !== "auto"
                      ? `Analyze this car sound recording and answer in language code: ${preferredLanguage}.`
                      : `Analyze this car sound recording. Reply in the same language as the driver's voice if possible; otherwise use English.`,
                },
                {
                  // 👇 هنا النوع الصحيح: input_file
                  type: "input_file",
                  file_id: uploadedFile.id,
                },
              ],
            },
          ],
        });

        const outputItem = response.output?.[0];
        const outputContent = outputItem?.content?.[0];

        const replyText =
          outputContent?.output_text?.text ||
          outputContent?.text ||
          JSON.stringify(response);

        const detectedLang = guessLanguage(replyText);
        const finalLang =
          preferredLanguage && preferredLanguage !== "auto"
            ? preferredLanguage
            : detectedLang || "en";

        return res.status(200).json({
          reply: replyText,
          language: finalLang,
        });
      } catch (apiError) {
        console.error("FixLens audio diagnosis error:", apiError);
        return res.status(500).json({
          error: "Audio diagnosis failed",
          details:
            apiError?.response?.data ||
            apiError.message ||
            String(apiError),
        });
      }
    });
  } catch (e) {
    console.error("Unexpected audio handler error:", e);
    return res.status(500).json({
      error: "Audio diagnosis failed",
      details: e.message || String(e),
    });
  }
}
