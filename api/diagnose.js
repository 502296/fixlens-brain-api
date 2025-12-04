import OpenAI from "openai";



const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Method not allowed" });

    }



    const { text, mode, language } = req.body || {};



    if (!text || typeof text !== "string" || text.trim().length === 0) {

      return res.status(400).json({ error: "Invalid or missing 'text' field" });

    }



    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",   // ← ← ← الموديل الصحيح 100%

      messages: [

        {

          role: "system",

          content: `

You are FixLens Auto, an AI mechanic assistant.

Reply in the same language the user writes in.

Be clear, friendly, and diagnostic-focused.

If user greets you, respond then ask about the car issue.

`

        },

        { role: "user", content: text }

      ],

      temperature: 0.7,

      max_tokens: 500,

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() ||

      "FixLens Auto could not generate a reply.";



    return res.status(200).json({ reply });

  } catch (error) {

    console.error("API ERROR:", error);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: error?.message || "unknown",

    });

  }

}
