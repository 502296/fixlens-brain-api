// api/diagnose.js



import OpenAI from "openai";

import { Readable } from "stream";



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const {

      issue,

      imageBase64,

      imageMime,

      audioBase64,

      audioMime,

      languageCode = "en",

    } = req.body || {};



    // لازم يكون عندنا واحد على الأقل من: نص أو صورة أو صوت

    if (!issue && !imageBase64 && !audioBase64) {

      return res.status(400).json({

        error: "You must provide issue text, imageBase64, or audioBase64",

      });

    }



    // --- تجهيز الـ MIME للصورة ---

    let mime = imageMime || "image/jpeg";

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    const messages = [];



    // --- SYSTEM MESSAGE ---

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You give clear, safe, step-by-step troubleshooting for real-world problems " +

            "(home appliances, vehicles, home issues, etc.). " +

            "Always answer in the user's language: " +

            languageCode +

            ". If something is dangerous, tell the user to stop and call a professional.",

        },

      ],

    });



    // --- نص المشكلة من المستخدم (إن وجد) ---

    if (issue) {

      messages.push({

        role: "user",

        content: [{ type: "text", text: issue }],

      });

    }



    // --- صورة من المستخدم (إن وجدت) ---

    if (imageBase64) {

      const imageContent = [

        {

          type: "input_image",

          image_url: {

            url: `data:${mime};base64,${imageBase64}`,

          },

        },

      ];



      // لو ماكو نص، نضيف تعليمات بسيطة للصورة

      if (!issue) {

        imageContent.push({

          type: "text",

          text:

            "This is the photo the user sent. Analyze what you see and relate it to the problem.",

        });

      }



      messages.push({

        role: "user",

        content: imageContent,

      });

    }



    // --- صوت من المستخدم (إن وجد) → Transcription ---

    let audioTranscript = "";

    if (audioBase64) {

      try {

        const buffer = Buffer.from(audioBase64, "base64");

        const stream = Readable.from(buffer);

        // نضيف اسم للـ stream حتى يتصرف مثل ReadStream من ملف

        stream.path = "voice-note.m4a";



        const transcription = await openai.audio.transcriptions.create({

          file: stream,

          model: "gpt-4o-transcribe",

          // نخلي اللغة نفس languageCode لو حاب

          language: languageCode,

        });



        audioTranscript = (transcription.text || "").trim();

      } catch (err) {

        console.error("Audio transcription error:", err);

        // لو حدث خطأ بالـ voice، ما نكسر الرد كله

      }



      if (audioTranscript) {

        messages.push({

          role: "user",

          content: [

            {

              type: "text",

              text:

                "This is a voice note from the user. Here is the transcription:\n\n" +

                audioTranscript,

            },

          ],

        });

      }

    }



    // --- استدعاء نموذج الدردشة مع الصورة + النص + (نص الصوت إن وجد) ---

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages,

      max_tokens: 700,

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "FixLens Brain could not generate a response.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens API ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err.message,

    });

  }

}
