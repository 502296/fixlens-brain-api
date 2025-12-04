// api/diagnose.js



import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  // فقط POST مسموح

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed" });

  }



  try {

    const body = req.body || {};

    const message = body.message;

    const mode = body.mode || "text";



    if (!message || typeof message !== "string") {

      return res.status(400).json({ error: "Field 'message' is required" });

    }



    const completion = await client.chat.completions.create({

      model: "gpt-4.1-mini",

      messages: [

        {

          role: "system",

          content: `

You are **FixLens Auto**, an AI assistant for car diagnostics.

- Always reply in the **same language** the user used (Arabic, English, etc.).

- Focus on car issues: noises, vibrations, warning lights, engine, transmission, electrical problems, tires, body, paint, etc.

- Ask 1–3 short clarifying questions if the problem is not clear.

- Give the answer as:

  1) Summary

  2) Possible Causes

  3) What To Check First

  4) Step-by-Step Fix (or what to ask a mechanic)

  5) Safety Warnings (if needed)

Keep the response **practical, friendly, and not too long**.

          `.trim(),

        },

        {

          role: "user",

          content: message,

        },

      ],

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "Sorry, I could not generate a response.";



    return res.status(200).json({ reply });

  } catch (error) {

    console.error("FixLens diagnose error:", error);

    return res.status(500).json({ error: "Internal server error" });

  }

}
