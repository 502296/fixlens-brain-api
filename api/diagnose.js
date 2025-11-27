// api/diagnose.js



import OpenAI, { toFile } from "openai";



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const {

      issue,

      imageBase64,

      imageMime,

      audioBase64,

      audioMime,

      languageCode = "en",

    } = req.body || {};



    if (!issue && !imageBase64 && !audioBase64) {

      return res.status(400).json({

        error:

          "You must provide at least one of: issue text, imageBase64, or audioBase64",

      });

    }



    // 1) لو عندنا صوت، نخليه نص باستخدام gpt-4o-transcribe

    let transcriptText = null;



    if (audioBase64) {

      try {

        const audioBuffer = Buffer.from(audioBase64, "base64");



        // نحاول نخمن الامتداد من الـ MIME

        let ext = "wav";

        if (audioMime === "audio/webm") ext = "webm";

        else if (audioMime === "audio/mpeg" || audioMime === "audio/mp3")

          ext = "mp3";

        else if (audioMime === "audio/mp4" || audioMime === "audio/m4a")

          ext = "m4a";



        const audioFile = await toFile(audioBuffer, `voice.${ext}`);



        const transcription = await openai.audio.transcriptions.create({

          file: audioFile,

          model: "gpt-4o-transcribe",

          // يمكنك ترك اللغة فاضية لو تحب يكتشفها:

          // language: languageCode,

        });



        transcriptText = transcription.text;

        console.log("Transcription:", transcriptText);

      } catch (err) {

        console.error("Audio transcription failed:", err);

        // ما نرمي الخطأ حتى ما نكسر الطلب كله

      }

    }



    // 2) ندمج المشكلة النصية + النص المفرغ من الصوت

    let finalIssue = (issue || "").trim();



    if (transcriptText && transcriptText.trim()) {

      const voiceText = transcriptText.trim();

      if (finalIssue) {

        finalIssue += `\n\nVoice note from the user (transcribed): ${voiceText}`;

      } else {

        finalIssue = `Voice note from the user: ${voiceText}`;

      }

    }



    // 3) نبني الرسائل لـ FixLens Brain

    const messages = [];



    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You analyze images and real-world problems (home appliances, cars, plumbing, HVAC, etc.) and give clear, step-by-step diagnostics and advice in the user's language.",

        },

      ],

    });



    if (finalIssue) {

      messages.push({

        role: "user",

        content: [{ type: "text", text: finalIssue }],

      });

    }



    if (imageBase64) {

      let mime = imageMime || "image/jpeg";

      if (mime === "image/heic" || mime === "image/heif") {

        mime = "image/jpeg";

      }



      messages.push({

        role: "user",

        content: [

          {

            type: "input_image",

            image_url: {

              url: `data:${mime};base64,${imageBase64}`,

            },

          },

        ],

      });

    }



    // 4) نطلب التحليل من gpt-4o-mini

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages,

      max_tokens: 700,

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "FixLens Brain could not generate a response.";



    return res.status(200).json({ reply });

  } catch (err) {

    console.error("FixLens API ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err?.message || "Unknown error",

    });

  }

}
