// api/diagnose.js



const OpenAI = require("openai");



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



module.exports = async (req, res) => {

  // نسمح فقط بالـ POST

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed. Use POST." });

  }



  try {

    const {

      message,

      category,

      uiLanguage,

      hasImage,

      // لو في المستقبل أضفنا وصف للصورة أو بيانات أخرى

      imageDescription,

    } = req.body || {};



    if (!message || !message.trim()) {

      return res.status(400).json({ error: "Message is required." });

    }



    const cleanedMessage = message.trim();

    const safeCategory = (category || "General").toString();

    const lang = (uiLanguage || "English").toString();



    // ===== System Prompt (قلب FixLens Brain) =====

    const systemPrompt = `

You are **FixLens Brain**, an AI assistant for diagnosing *real-world problems*.



Your ONLY focus areas are:

1) Auto – car issues, noises, leaks, warning lights, steering, brakes, etc.

2) Home – plumbing, electricity, doors, windows, walls, leaks, HVAC, etc.

3) Appliances – washers, dryers, dishwashers, fridges, ovens, small appliances, etc.



RULES:

- If the user asks about something outside Auto / Home / Appliances,

  politely refuse and invite them to ask about car, home, or appliance problems.

- Ask 2–4 short follow-up questions when needed for clarity or safety.

- Always think about safety first (fire, electricity, gas, heavy parts).

  If there is any serious risk, tell the user to stop and call a professional

  or emergency services.

- Give answers as clear, numbered, step-by-step instructions when possible.

- Keep answers focused and usually under ~400 words unless the user asks

  for more detail.

- If "hasImage" is true, you DO NOT see the photo pixels yet.

  Treat the user's text as a description of what you see in the photo.

- Language:

    * If uiLanguage is Arabic (contains "عرب" or equals "Arabic" / "العربية"),

      answer in Modern Standard Arabic.

    * Otherwise, answer in the same language as the user's message if possible,

      or in English.

- You are polite, practical, and professional. 

`;



    // نبني رسالة المستخدم مع شوية ميتا

    let userPrompt = `User category: ${safeCategory}\n`;

    userPrompt += `UI language: ${lang}\n`;

    userPrompt += `Has image attached: ${hasImage ? "yes" : "no"}\n`;

    if (imageDescription && imageDescription.trim()) {

      userPrompt += `Image description (if any): ${imageDescription.trim()}\n\n`;

    } else {

      userPrompt += `\n`;

    }

    userPrompt += `User message:\n${cleanedMessage}`;



    // ===== Call OpenAI =====

    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      temperature: 0.4,

      messages: [

        { role: "system", content: systemPrompt },

        { role: "user", content: userPrompt },

      ],

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() || "";



    if (!reply) {

      // في حال نادرة جداً لو رجع فاضي

      return res.status(200).json({

        reply:

          "FixLens Brain could not generate a detailed reply this time. Please try again with a bit more detail about the problem.",

      });

    }



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens Brain error:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error.",

    });

  }

};
