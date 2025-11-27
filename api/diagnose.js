// api/diagnose.js

import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  if (req.method !== "POST") {

    res.status(405).json({ error: "Method not allowed" });

    return;

  }



  try {

    const body =

      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};



    let {

      issue,

      languageCode = "en",

      imageBase64,

      imageMime,

      audioBase64,

      audioMime,

    } = body;



    if (!issue && !imageBase64 && !audioBase64) {

      res

        .status(400)

        .json({ error: "Missing issue, image, or audio for FixLens." });

      return;

    }



    // لو فيه صوت، نحوله نص بـ Whisper ونضيفه للوصف

    if (audioBase64) {

      const audioBuffer = Buffer.from(audioBase64, "base64");



      const transcription = await client.audio.transcriptions.create({

        file: {

          data: audioBuffer,

          name: "voice.m4a",

        },

        model: "whisper-1",

        response_format: "text",

      });



      const textFromAudio =

        typeof transcription === "string"

          ? transcription

          : transcription.text || "";



      if (textFromAudio.trim().length > 0) {

        issue = (issue ? issue + "\n\n" : "") +

          `User voice description (transcribed): ${textFromAudio}`;

      }

    }



    const systemPrompt = `

You are **FixLens**, an AI assistant for real-world troubleshooting.

You CAN see and analyze images, and you can use transcribed audio descriptions.

Never say that you cannot analyze images or voice notes.



You help with home appliances, vehicles, and home issues.



- Always answer in the user's language when possible. User language code: ${languageCode}.

- Be practical, step-by-step, and clear.

- Emphasize safety instructions.

- If the situation is dangerous or unclear, recommend contacting a professional technician.

`.trim();



    const userParts = [];



    if (issue) {

      userParts.push({

        type: "text",

        text: issue,

      });

    }



    if (imageBase64 && imageMime) {

      userParts.push({

        type: "input_image",

        image_url: {

          url: `data:${imageMime};base64,${imageBase64}`,

        },

      });

    }



    const messages = [

      { role: "system", content: systemPrompt },

      { role: "user", content: userParts },

    ];



    const completion = await client.chat.completions.create({

      model: "gpt-4.1-mini", // تقدر تغيّرها لاحقاً لـ gpt-4.1 أو gpt-4o

      messages,

      temperature: 0.4,

    });



    const reply =

      completion.choices?.[0]?.message?.content?.trim() ||

      "Sorry, I couldn't generate a response.";



    res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens diagnose error:", err);

    res.status(500).json({

      error: "FixLens Brain error",

      message: err.message || String(err),

    });

  }

}
