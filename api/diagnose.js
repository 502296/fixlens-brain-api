// api/diagnose.js



import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res

      .status(405)

      .json({ error: "Method not allowed. Use POST instead." });

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



    const hasImage = !!imageBase64 && !!imageMime;

    const hasAudio = !!audioBase64 && !!audioMime;

    const hasText = !!(issue && issue.trim());



    if (!hasText && !hasImage && !hasAudio) {

      return res

        .status(400)

        .json({ error: "Missing issue, imageBase64 or audioBase64" });

    }



    // نبني محتوى رسالة المستخدم (Text + Image + Audio)

    const userContent = [];



    if (hasText) {

      const basePrompt = `

You are **FixLens Brain**, an expert troubleshooting assistant for:

- home appliances (refrigerators, dryers, washers, HVAC, etc.)

- vehicles and engines

- general home issues and maintenance



The user might write in English or Arabic. 

Always reply in the requested language code: "${languageCode}".



When images are provided, carefully analyze all visual details (dust, leaks, rust, broken parts, wiring, etc.).

When audio is provided, treat it as a spoken description of the issue.

Give:

1) A short summary of what you think is happening.

2) Step-by-step troubleshooting actions.

3) Clear safety notes (unplug, turn off water/gas, etc.) when needed.

4) When to call a professional technician.



User description:

${issue}

      `.trim();



      userContent.push({

        type: "input_text",

        text: basePrompt,

      });

    }



    if (hasImage) {

      userContent.push({

        type: "input_image",

        image_url: `data:${imageMime};base64,${imageBase64}`,

      });

    }



    if (hasAudio) {

      // نحاول تمرير الصوت كنص مدخل للموديل (الموديل نفسه يتعامل مع الصوت)

      const format =

        (audioMime && audioMime.split("/")[1]) || "m4a";



      userContent.push({

        type: "input_audio",

        input_audio: {

          data: audioBase64,

          format,

        },

      });

    }



    const response = await client.responses.create({

      model: "gpt-4.1-mini",

      input: [

        {

          role: "user",

          content: userContent,

        },

      ],

    });



    const text =

      response.output_text ||

      (response.output &&

        response.output[0] &&

        response.output[0].content &&

        response.output[0].content[0] &&

        response.output[0].content[0].text) ||

      JSON.stringify(response);



    return res.status(200).json({

      reply: text,

    });

  } catch (err) {

    console.error("FixLens /api/diagnose error:", err);

    return res

      .status(500)

      .json({ error: "FixLens Brain internal error", details: String(err) });

  }

}
