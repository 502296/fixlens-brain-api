// api/diagnose.js

import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    res.status(405).json({ error: "Method not allowed" });

    return;

  }



  try {

    // في بعض الأحيان body يأتي كـ string من Vercel

    const body =

      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};



    const {

      issue,

      languageCode = "en",

      imageBase64,

      imageMime,

      // حاليا نتجاهل الصوت حتى نضبطه لاحقاً

      // audioBase64,

      // audioMime,

    } = body;



    if (!issue && !imageBase64) {

      res

        .status(400)

        .json({ error: "Missing issue or image for FixLens diagnosis." });

      return;

    }



    const systemPrompt = `

You are **FixLens**, an AI assistant for real-world troubleshooting.

You help with home appliances, vehicles, and home issues.



- Always be practical and step-by-step.

- Mention safety steps clearly.

- If you're not sure, say that a professional technician should inspect it.

- Answer in the language of the user. User language code: ${languageCode}.

`.trim();



    const userParts = [];



    if (issue) {

      userParts.push({

        type: "text",

        text: issue,

      });

    }



    if (imageBase64 && imageMime) {

      userParts.push({

        type: "input_image",

        image_url: {

          url: `data:${imageMime};base64,${imageBase64}`,

        },

      });

    }



    const messages = [

      { role: "system", content: systemPrompt },

      { role: "user", content: userParts },

    ];



    const completion = await client.chat.completions.create({

      model: "gpt-4.1-mini", // أو gpt-4o / gpt-4.1 حسب الخطة

      messages,

      temperature: 0.4,

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() ||

      "Sorry, I couldn't generate a response.";



    res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens diagnose error:", err);

    res.status(500).json({

      error: "FixLens Brain error",

      message: err.message || String(err),

    });

  }

}
