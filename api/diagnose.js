// api/diagnose.js



import OpenAI from "openai";

import fs from "fs";

import path from "path";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Method not allowed" });

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



    let finalIssue =

      (issue && issue.trim()) ||

      "The user is asking for help with a real-world problem. Ask clarifying questions if needed.";



    // ------------ 1) لو فيه صوت: نعمل له Transcription ونضيفه للنص ------------

    if (audioBase64) {

      try {

        const tmpFile = path.join(

          "/tmp",

          `fixlens_voice_${Date.now().toString()}.m4a`

        );

        const buffer = Buffer.from(audioBase64, "base64");

        fs.writeFileSync(tmpFile, buffer);



        const transcription = await client.audio.transcriptions.create({

          model: "gpt-4o-transcribe",

          file: fs.createReadStream(tmpFile),

          language: languageCode,

        });



        fs.unlink(tmpFile, () => {});



        if (transcription?.text) {

          finalIssue +=

            `\n\nVoice note from the user (transcribed): ${transcription.text}`;

        }

      } catch (err) {

        console.error("Audio transcription error:", err);

        // لو فشل الصوت نكمل عادي فقط بدون الصوت

      }

    }



    // ------------ 2) نبني محتوى رسالة المستخدم (نص + صورة لو موجودة) ------------

    const userContent = [

      {

        type: "text",

        text: finalIssue,

      },

    ];



    if (imageBase64) {

      const mime = imageMime || "image/jpeg";

      userContent.push({

        type: "input_image",

        image_url: {

          url: `data:${mime};base64,${imageBase64}`,

        },

      });

    }



    // ------------ 3) نطلب من FixLens Brain الرد ------------

    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        {

          role: "system",

          content: [

            {

              type: "text",

              text:

                "You are FixLens Brain, an expert AI for diagnosing real-world problems: home appliances, vehicles, and home issues. " +

                "Explain step by step, be practical and safety-conscious. " +

                "Always answer in the same language the user used.",

            },

          ],

        },

        {

          role: "user",

          content: userContent,

        },

      ],

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "I'm sorry, I couldn't generate a response.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens diagnose error:", err);

    // مهم: نرجّع 200 مع رسالة مفهومة حتى لا يكسر التطبيق

    return res.status(200).json({

      reply:

        "I'm sorry, FixLens Brain ran into a technical issue while analyzing your image or voice note. " +

        "Please type a short description of the problem so I can help you step by step.",

    });

  }

}
