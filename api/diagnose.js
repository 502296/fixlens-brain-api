// api/diagnose.js



import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed" });

  }



  try {

    // نتأكد أن الـ body دايماً كـ object

    const body =

      typeof req.body === "string"

        ? JSON.parse(req.body || "{}")

        : (req.body || {});



    const {

      issue,

      languageCode,

      imageBase64,

      imageMime,

      audioBase64,

      audioMime,

    } = body;



    if (!issue || typeof issue !== "string") {

      return res.status(400).json({ error: "Missing 'issue' text" });

    }



    const lang = languageCode || "en";



    const systemPrompt = `

You are FixLens Brain, an expert AI that diagnoses real-world problems:

- home appliances (fridge, washer, dryer, dishwasher, HVAC)

- cars and vehicles

- home issues (leaks, mold, wiring, etc.)

Respond in language: ${lang}.

Give step-by-step troubleshooting, safety warnings, and clear next actions.

If an image is provided, use it to improve your diagnosis.

If audio is provided, assume the user described the issue verbally.

`;



    // نبني محتوى المستخدم (نص + صورة إن وجدت)

    const userContent = [

      {

        type: "text",

        text: `User description:\n${issue}`,

      },

    ];



    if (imageBase64) {

      const mime = imageMime || "image/jpeg";

      userContent.push({

        type: "image_url",

        image_url: {

          url: `data:${mime};base64,${imageBase64}`,

        },

      });

    }



    if (audioBase64) {

      // حالياً لا نفريغ الصوت، لكن نخبر الموديل:

      userContent.push({

        type: "text",

        text:

          "Note: The user also sent a voice note (audio file). " +

          "Assume they verbally described the same issue in more detail. " +

          "Ask them to type any extra important details if needed.",

      });

    }



    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        { role: "system", content: systemPrompt },

        { role: "user", content: userContent },

      ],

      temperature: 0.4,

      max_tokens: 900,

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "I couldn't generate a response. Please try again.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens diagnose error:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err?.message || String(err),

    });

  }

}
