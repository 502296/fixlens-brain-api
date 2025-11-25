// api/diagnose.js



const OpenAI = require("openai");



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



/**

 * FixLens Brain – Diagnosis API

 * - يستقبل نص المشكلة + اللغة + الهستوري (اختياري)

 * - يرجّع جواب واحد منسّق، بدون تكرار العناوين

 */

module.exports = async (req, res) => {

  // نسمح فقط بالـ POST

  if (req.method !== "POST") {

    res.setHeader("Allow", "POST");

    return res.status(405).json({ error: "Method not allowed" });

  }



  try {

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;



    const {

      message,

      uiLanguage,

      category,

      history, // لو حابب نستخدمه لاحقاً

      hasImage,

    } = body || {};



    if (!message || !String(message).trim()) {

      return res.status(400).json({ error: "Message is required." });

    }



    const userText = String(message).trim();



    // نبني البرومبت

    const systemPrompt = `

You are **FixLens Brain**, an AI assistant that diagnoses **real-world problems**

only in three domains:

1) Cars & vehicles

2) Home & property

3) Appliances & devices



Rules:

- Answer in the SAME language the user is using (Arabic, English, etc).

- Always focus on practical, realistic, real-world guidance.

- If the user’s message is just a greeting or very general ("hello", "كيفك؟"),

  reply as a friendly assistant and ask what problem they want to diagnose.

- If the issue is not related to cars / home / appliances, say politely

  that FixLens is specialized only in these three areas.



When the user describes a real problem:

- First: give a **very short summary** of what you think is going on.

- Second: give **clear step-by-step recommended actions**.

- Third: add a short **safety note** (what NOT to do, and when to call a professional).



Format:

- Use short paragraphs and bullet points.

- Keep the answer compact and easy to read on a phone screen.

- Do NOT repeat the same text twice.

- Do NOT leave empty sections or dashes; only include sections that have content.



Extra context for this request:

- Category selected in the app: ${category || "not specified"}

- UI language: ${uiLanguage || "not specified"}

- The user may have attached a photo: ${hasImage ? "YES" : "NO"}.

If a photo is mentioned, infer what it likely shows from the text.

`;



    // نرسل الطلب إلى GPT-4o mini

    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      temperature: 0.4,

      messages: [

        { role: "system", content: systemPrompt },

        { role: "user", content: userText },

      ],

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() ||

      "FixLens Brain could not generate a reply.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens Brain API error:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error.",

    });

  }

};
