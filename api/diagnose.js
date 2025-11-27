// api/diagnose.js



import OpenAI from "openai";



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const { issue, imageBase64, imageMime, languageCode = "en" } = req.body;



    if (!issue && !imageBase64) {

      return res.status(400).json({

        error: "You must provide issue text OR imageBase64",

      });

    }



    let mime = imageMime || "image/jpeg";



    // Convert HEIC → JPEG

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    const openai = new OpenAI({

      apiKey: process.env.OPENAI_API_KEY,

    });



    const messages = [];



    // SYSTEM

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You analyze images, diagnose real-world problems, and respond in the user’s language.",

        },

      ],

    });



    // USER TEXT

    if (issue) {

      messages.push({

        role: "user",

        content: [{ type: "text", text: issue }],

      });

    }



    // USER IMAGE

    if (imageBase64) {

      messages.push({

        role: "user",

        content: [

          {

            type: "input_image",

            image_url: {

              url: `data:${mime};base64,${imageBase64}`,

            },

          },

        ],

      });

    }



    // CALL OPENAI

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages,

      max_tokens: 500,

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
