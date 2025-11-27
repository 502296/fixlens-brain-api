// api/diagnose.js



import OpenAI from "openai";

import fridgeKB from "../brain/knowledge/fridge.json" assert { type: "json" };



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed. Use POST." });

  }



  try {

    const {

      issue,

      languageCode = "en",

      hasImage = false,

      hasAudio = false,

    } = req.body || {};



    if (!issue && !hasImage && !hasAudio) {

      return res.status(400).json({

        error: "Missing issue description or media flags.",

      });

    }



    // 🧠 نجهّز نص الـ Knowledge Base للثلاجات

    const fridgeKBText = JSON.stringify(fridgeKB);



    // 🧾 نبني سياق المستخدم

    const userParts = [];



    if (issue && issue.trim().length > 0) {

      userParts.push(`User description:\n${issue}`);

    }



    if (hasImage) {

      userParts.push(

        "The user also attached one or more photos related to this issue. " +

          "You do NOT see the image directly, but assume it shows the appliance or problem area."

      );

    }



    if (hasAudio) {

      userParts.push(

        "The user also attached an audio/voice note describing the issue or strange noises. " +

          "You do NOT hear the audio directly, but you should think about typical sounds: humming, clicking, rattling, grinding, squealing, etc."

      );

    }



    const userContext = userParts.join("\n\n");



    // 🧠 System Prompt: FixLens Brain + Knowledge Base

    const systemPrompt = `

You are **FixLens Brain**, an AI technician that helps diagnose real-world problems

in appliances, refrigerators, washing machines, AC units, cars, and electrical systems.



Today, you have access to a structured **Refrigerator Knowledge Base** in JSON format.

Use it whenever the issue is related to a fridge or freezer.



----------------- FRIDGE KNOWLEDGE BASE (JSON) -----------------

${fridgeKBText}

----------------------------------------------------------------



Rules for using this knowledge:



1. When the problem is about a **fridge or freezer**:

   - Match the user's symptoms, noises, and observations to the closest issues in the JSON.

   - Use fields: symptoms, sounds, causes, checks, recommended_actions, danger_level, tags.

   - If multiple issues are possible, list them from MOST likely to LEAST likely.

   - Always include:

     a) Short summary of the most likely cause.

     b) Step-by-step checks the user can do safely.

     c) What is safe for a normal user, and when to call a professional.

     d) Safety warnings (electric shock, fire risk, refrigerant, gas, etc.) if danger_level is "high" or "critical".



2. If the problem is **not** about a fridge:

   - Ignore the JSON and use your general technical knowledge as FixLens Brain.

   - Still answer in a structured, step-by-step way.



3. If the user indicates an image was sent (hasImage = true):

   - You do not actually see the image, but infer what it likely shows.

   - For fridges, think about: dirty coils, ice buildup, leaks, broken parts, burned marks, loose wires, etc.



4. If the user indicates an audio/voice note was sent (hasAudio = true):

   - You do not hear the audio directly.

   - Instead, reason about common sounds: humming, buzzing, rattling, knocking, clicking, grinding, squealing.

   - Map those sounds to likely issues in the knowledge base (for fridges) or your general knowledge.



5. Language:

   - Answer in the same language as the user if possible.

   - Detected languageCode from app is: ${languageCode}.

   - If the user writes in Arabic, answer in clear Modern Standard Arabic.

   - If English, answer in clear, simple English.



6. Style:

   - Be calm, practical, and friendly.

   - Start with a 2–3 line summary of the situation and likely cause.

   - Then use numbered steps (1, 2, 3, …) for diagnosis and actions.

   - Mark safety sections clearly, for example: **Safety warning** or **تحذير أمان**.



You are not just a chatbot. You are "FixLens Brain" — an AI technician that thinks like a real technician,

using both the JSON knowledge base and your own reasoning.

    `.trim();



    // 🧠 نرسل الطلب إلى GPT-4.1-mini عبر واجهة responses

    const response = await client.responses.create({

      model: "gpt-4.1-mini",

      input: [

        {

          role: "system",

          content: [

            {

              type: "input_text",

              text: systemPrompt,

            },

          ],

        },

        {

          role: "user",

          content: [

            {

              type: "input_text",

              text: userContext,

            },

          ],

        },

      ],

    });



    // 📝 نأخذ النص من الرد

    let replyText = "";



    try {

      replyText =

        response.output?.[0]?.content?.[0]?.text ??

        JSON.stringify(response);

    } catch (e) {

      replyText = JSON.stringify(response);

    }



    return res.status(200).json({

      reply: replyText,

      model: response.model,

      usage: response.usage,

    });

  } catch (error) {

    console.error("FixLens Brain diagnose error:", error);



    return res.status(500).json({

      error: "FixLens Brain internal error",

      details:

        error?.response?.data ||

        error?.message ||

        error?.toString() ||

        "Unknown error",

    });

  }

}
