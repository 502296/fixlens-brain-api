const OpenAI = require("openai");



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



module.exports = async (req, res) => {

  if (req.method !== "POST") {

    res.status(405).json({ error: "Method not allowed" });

    return;

  }



  try {

    const { message, category, uiLanguage, hasImage } =

      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};



    if (!message) {

      res.status(400).json({ error: "Message is required." });

      return;

    }



    const systemPrompt = `

You are FixLens Brain, an AI assistant for diagnosing real-world problems.

Category: ${category}

Language: ${uiLanguage}

User attached image: ${hasImage ? "Yes" : "No"}

Answer in the same user language (${uiLanguage}).

    `.trim();



    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        { role: "system", content: systemPrompt },

        { role: "user", content: message }

      ],

    });



    const answer =

      completion.choices?.[0]?.message?.content ||

      "FixLens Brain could not return an answer.";



    res.status(200).json({ answer });

  } catch (err) {

    console.error(err);

    res.status(500).json({ error: "Internal error", details: String(err) });

  }

};
