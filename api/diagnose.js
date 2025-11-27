// api/diagnose.js



import OpenAI from "openai";



export default async function handler(req, res) {

  try {

    // نسمح فقط بطلبات POST

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    // نتأكد أن body موجود ومقروء

    let body = req.body || {};

    if (typeof body === "string") {

      try {

        body = JSON.parse(body);

      } catch {

        body = {};

      }

    }



    const {

      issue,

      imageBase64,

      imageMime,

      languageCode = "en",

    } = body;



    // لازم يكون عندنا نص أو صورة على الأقل

    if (!issue && !imageBase64) {

      return res.status(400).json({

        error: "You must provide issue text OR imageBase64",

      });

    }



    // ----- تجهيز الـ MIME للصورة -----

    let mime = imageMime || "image/jpeg";



    // تحويل HEIC / HEIF إلى JPEG

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    // نختار الموديل:

    // - لو في صورة → gpt-4o (يدعم Vision)

    // - لو نص فقط → gpt-4o-mini (أرخص وأسرع)

    const model = imageBase64 ? "gpt-4o" : "gpt-4o-mini";



    const openai = new OpenAI({

      apiKey: process.env.OPENAI_API_KEY,

    });



    // ----- بناء الرسائل -----

    const messages = [];



    // SYSTEM

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain, an expert technician. You diagnose real-world problems in home appliances, vehicles, and home issues using images and text. " +

            "Always answer in the same language the user used (languageCode: " +

            languageCode +

            "). Start with safety tips, then give step-by-step guidance.",

        },

      ],

    });



    // USER TEXT (إن وجد)

    if (issue) {

      messages.push({

        role: "user",

        content: [{ type: "text", text: issue }],

      });

    }



    // USER IMAGE (إن وجدت)

    if (imageBase64) {

      messages.push({

        role: "user",

        content: [

          {

            type: "text",

            text: "Here is a photo related to my problem.",

          },

          {

            // ✅ الشكل الصحيح للصورة مع chat.completions

            type: "image_url",

            image_url: {

              url: `data:${mime};base64,${imageBase64}`,

            },

          },

        ],

      });

    }



    // ----- استدعاء OpenAI -----

    const completion = await openai.chat.completions.create({

      model,

      messages,

      max_tokens: 700,

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() ||

      "FixLens Brain could not generate a response.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens API ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: String(err?.message || err),

    });

  }

}
