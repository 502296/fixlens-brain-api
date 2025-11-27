// api/diagnose.js



import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    res.status(405).json({ message: "Method not allowed" });

    return;

  }



  try {

    const {

      issue,

      languageCode = "en",

      imageBase64,

      imageMime,

      audioBase64,

      audioMime,

    } = req.body || {};



    let finalIssue = issue || "";



    // لو في Voice Note نخبر النموذج (مستقبلاً ممكن نضيف Transcription حقيقية)

    if (audioBase64) {

      finalIssue +=

        "\n\nThe user also attached a voice note describing the issue. " +

        "If needed, ask them to type any extra details.";

    }



    // نبني محتوى الرسالة (نص + صورة اختيارية)

    const content = [];



    if (finalIssue.trim().length > 0) {

      content.push({

        type: "input_text",

        text: finalIssue,

      });

    }



    if (imageBase64) {

      const mime = imageMime || "image/jpeg";

      content.push({

        type: "input_image",

        image_url: `data:${mime};base64,${imageBase64}`,

      });

    }



    if (content.length === 0) {

      res.status(400).json({ message: "Missing issue text." });

      return;

    }



    const response = await client.responses.create({

      model: "gpt-4.1-mini",

      instructions:

        "You are FixLens, an AI that diagnoses real-world problems " +

        "(home appliances, vehicles, and home issues). " +

        "Give clear, step-by-step troubleshooting. " +

        "Respond in the same language as the user when possible.",

      input: [

        {

          role: "user",

          content,

        },

      ],

    });



    let replyText = "I couldn't generate a response.";

    try {

      const first = response.output[0];

      const firstContent = first?.content?.[0];

      replyText = firstContent?.text || JSON.stringify(response);

    } catch (e) {

      replyText = JSON.stringify(response);

    }



    res.status(200).json({ reply: replyText });

  } catch (err) {

    console.error("FixLens diagnose error:", err);

    res.status(500).json({

      message:

        "FixLens Brain had a problem processing this request. Please try again.",

    });

  }

}
