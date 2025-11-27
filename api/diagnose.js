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



    const { issue, imageBase64, imageMime } = req.body || {};



    if (!issue && !imageBase64) {

      return res.status(400).json({

        error: "You must provide issue text OR imageBase64",

      });

    }



    // ---------- IMAGE MIME ----------

    let mime = imageMime || "image/jpeg";

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg"; // نحول HEIC إلى JPEG

    }



    // ---------- BUILD MESSAGES ----------

    const messages = [];



    // SYSTEM MESSAGE

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You analyze photos and text about real-world problems (home appliances, vehicles, home issues) and give clear, safe, step-by-step troubleshooting. Always answer in the same language the user used.",

        },

      ],

    });



    // USER MESSAGE (TEXT + OPTIONAL IMAGE في نفس الرسالة)

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



    messages.push({

      role: "user",

      content: userContent,

    });



    // ---------- CALL OPENAI ----------

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

      details: err?.response?.data || err.message || String(err),

    });

  }

}
