// api/diagnose.js



const OpenAI = require("openai");



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



/**

 * FixLens Brain – Diagnosis API

 *

 * يستقبل:

 * - message  (وصف المشكلة)

 * - language (اختياري، مثلاً English / Arabic)

 * - conversationId (اختياري للتتبع)

 *

 * يرجع:

 * { answer: "... النص النهائي ..." }

 */

module.exports = async (req, res) => {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed" });

  }



  try {

    const body = req.body || {};

    const message = (body.message || "").trim();

    const language = body.language || "English";

    const conversationId = body.conversationId || null;



    if (!message) {

      return res.status(400).json({ error: "Message is required." });

    }



    const systemPrompt = `

You are FixLens Brain, a practical AI technician.

You help users diagnose real-world issues with cars, appliances, and homes.

Always respond in a clear, friendly, step-by-step way.

If the user language is not English, respond in that language when possible.

`;



    const userPrompt = `

User message:

${message}



Language: ${language}

Conversation ID: ${conversationId ?? "N/A"}

`;



    const response = await client.responses.create({

      model: "gpt-4.1-mini",

      input: [

        {

          role: "system",

          content: systemPrompt,

        },

        {

          role: "user",

          content: userPrompt,

        },

      ],

    });



    // استخراج النص من استجابة OpenAI

    const output = response.output?.[0]?.content?.[0]?.text || "";

    const answer = output.trim() || "I analyzed your issue but couldn't generate a detailed answer.";



    return res.status(200).json({

      answer,

    });

  } catch (err) {

    console.error("FixLens Brain error:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error.",

    });

  }

};
