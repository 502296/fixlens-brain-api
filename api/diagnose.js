// api/diagnose.js



import OpenAI from "openai";



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

      audioFormat = "wav",

      languageCode = "en",

    } = req.body || {};



    if (!issue && !imageBase64 && !audioBase64) {

      return res.status(400).json({

        error: "You must provide text, imageBase64, or audioBase64.",

      });

    }



    // 👁️ ضبط الـ MIME للصورة

    let mime = imageMime || "image/jpeg";

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    const messages = [];



    // 🧠 SYSTEM

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You analyze text, images, and short voice notes to diagnose real-world problems (home appliances, vehicles, home issues). " +

            "Always respond in the same language the user uses. Be clear, step-by-step, and practical. If safety is involved, warn the user clearly.",

        },

      ],

    });



    // 👤 USER – نجهز الكونتنت في رسالة واحدة

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

          detail: "high",

        },

      });

    }



    if (audioBase64) {

      userContent.push({

        type: "input_audio",

        input_audio: {

          data: audioBase64,

          // لازم تكون نفس الفورمات الي تبعتها من الموبايل (يفضل wav)

          format: audioFormat || "wav",

        },

      });

    }



    messages.push({

      role: "user",

      content: userContent,

    });



    // 🧠 CALL OPENAI

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages,

      max_tokens: 600,

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "FixLens Brain could not generate a response.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens API ERROR:", err?.response?.data || err.message);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err.message,

    });

  }

}
