// api/diagnose.js



import OpenAI from "openai";



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  try {

    // السماح بـ POST فقط

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const {

      issue,

      imageBase64,

      imageMime,

      languageCode = "en",

      // لو حاب ترسل فلاغ من الموبايل أن هناك صوت

      hasAudio = false,

    } = req.body || {};



    // لو ماكو نص ولا صورة ولا صوت

    if (!issue && !imageBase64 && !hasAudio) {

      return res.status(400).json({

        error: "You must provide issue text, imageBase64, or audio.",

      });

    }



    // حالياً: الصوت غير مدعوم، لكن لا نُسقط الـ API

    if (hasAudio && !issue && !imageBase64) {

      return res.status(200).json({

        reply:

          "I'm currently unable to process voice notes directly. Please type a short description of the issue so I can help you step by step.",

      });

    }



    // معالجة نوع الصورة

    let mime = imageMime || "image/jpeg";

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    // ==== بناء الرسائل ====



    const messages = [];



    // SYSTEM MESSAGE

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain, an AI technician that analyzes images and user descriptions to troubleshoot real-world problems (home appliances, vehicles, home issues). " +

            "Always reply in the same language the user used (English or Arabic). " +

            "Be calm, friendly, and very clear. Start with safety steps if there is any risk of electric shock, gas leak, or injury, then give step-by-step diagnosis.",

        },

      ],

    });



    // USER CONTENT (نجمع النص + الصورة في رسالة واحدة)

    const userContent = [];



    if (issue) {

      userContent.push({

        type: "text",

        text: issue,

      });

    }



    if (imageBase64) {

      userContent.push({

        type: "image_url",

        image_url: {

          url: `data:${mime};base64,${imageBase64}`,

        },

      });

    }



    // لو لأي سبب ماكو شيء، نضيف نص بسيط

    if (userContent.length === 0) {

      userContent.push({

        type: "text",

        text:

          "The user did not send any description or image. Please kindly ask them to describe their problem.",

      });

    }



    messages.push({

      role: "user",

      content: userContent,

    });



    // ==== الاتصال مع OpenAI ====



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

    console.error("FixLens API ERROR:", err?.response?.data || err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err?.message || "Unknown error",

    });

  }

}
