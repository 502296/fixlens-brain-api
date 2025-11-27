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

      languageCode = "en",

      hasImage,

      hasAudio,

    } = req.body || {};



    if (!issue && !hasImage && !hasAudio) {

      return res.status(400).json({

        error: "You must provide issue text or an attachment",

      });

    }



    // نبني نص المستخدم مع ملاحظات عن الصورة/الصوت (بدون إرسال البيكسلات)

    let userPrompt = (issue || "").trim();



    if (hasImage) {

      userPrompt +=

        "\n\n[Note for FixLens Brain: The user attached an image in the app. " +

        "You cannot see the actual pixels in this API version. " +

        "Ask the user to describe what they see in the photo (colors, positions, damaged parts, leaks, noises, etc.) " +

        "and then give your best real-world diagnosis based on their description.]";

    }



    if (hasAudio) {

      userPrompt +=

        "\n\n[Note for FixLens Brain: The user recorded a voice note in the app. " +

        "Assume the text above is the transcription. " +

        "If things are unclear, ask short follow-up questions before giving a precise diagnosis.]";

    }



    const systemPrompt =

      "You are FixLens Brain, an expert real-world troubleshooter. " +

      "You help with cars, appliances, home issues, devices and more. " +

      "Explain clearly, step by step, and keep your tone calm, friendly, and confident. " +

      "Always give practical steps the user can try safely at home, and mention when they should call a professional or emergency service.";



    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        {

          role: "system",

          content: systemPrompt,

        },

        {

          role: "user",

          content: userPrompt || "The user did not write text. Ask them calmly to describe the issue.",

        },

      ],

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

      details: err?.message ?? String(err),

    });

  }

}s
