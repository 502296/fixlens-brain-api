// api/diagnose.js



const OpenAI = require("openai");



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



module.exports = async (req, res) => {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed" });

  }



  try {

    const { userMessage, category, uiLanguage, hasImage } = req.body || {};



    if (!userMessage || !userMessage.trim()) {

      return res.status(400).json({ error: "Message is required." });

    }



    // نضبط القيم الافتراضية

    const safeCategory = category || "General";

    const safeLanguage = uiLanguage || "English";



    const systemPrompt = `

You are **FixLens Brain**, an AI assistant for diagnosing *real-world technical problems*.



Areas you focus on:

- Auto (cars, steering, brakes, engine, leaks, noises…)

- Home (plumbing, electricity, doors, windows, leaks…)

- Appliances (washer, dryer, fridge, oven, AC…).



Rules:

- Always be **practical and step-by-step**.

- First, help the user **understand the problem**.

- Then, give **clear steps**: what to check, what tools, what to do.

- If something is dangerous (electricity, fuel, lifting a car, gas, etc.) explain the risk and advise to call a professional.

- Never invent measurements or part numbers if you are not sure.

- If the user’s message is outside Auto/Home/Appliances, answer politely but stay helpful.



Language:

- Try to respond in the **same language** the user is using.

- If the UI language is "${safeLanguage}", use it as a hint.

- It is OK to mix short English terms if needed for tools or parts.



Context:

- Category: ${safeCategory}

- The user ${hasImage ? "also sent a photo of the problem." : "did not send a photo this time."}

`.trim();



    const userPrompt = `

User message:

${userMessage}

`.trim();



    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        { role: "system", content: systemPrompt },

        { role: "user", content: userPrompt },

      ],

      temperature: 0.4,

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() || "";



    if (!reply) {

      return res.status(500).json({ error: "FixLens Brain: empty reply." });

    }



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens Brain error:", err);

    return res.status(500).json({

      error: "FixLens Brain: internal error.",

    });

  }

};
