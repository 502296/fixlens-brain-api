// api/diagnose.js



export default async function handler(req, res) {

  try {

    // فقط POST مسموح

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const { issue, imageBase64, imageMime } = req.body || {};



    // لازم يا نص، يا صورة، يا الاثنين معًا

    if (!issue && !imageBase64) {

      return res.status(400).json({

        error: "You must provide issue text OR imageBase64",

      });

    }



    // نوع الصورة الافتراضي

    let mime = imageMime || "image/jpeg";

    if (mime === "image/heic" || mime === "image/heif") {

      mime = "image/jpeg";

    }



    // نبني الرسائل لـ Chat Completions

    const messages = [];



    // SYSTEM MESSAGE

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain. You analyze images and text to diagnose real-world problems (home appliances, vehicles, home issues). " +

            "Always answer step by step, in the same language the user used (English or Arabic).",

        },

      ],

    });



    // USER MESSAGE (نمزج النص + الصورة في رسالة واحدة)

    const userContent = [];



    if (issue) {

      userContent.push({

        type: "text",

        text: issue,

      });

    }



    if (imageBase64) {

      userContent.push({

        type: "image_url",

        image_url: {

          url: `data:${mime};base64,${imageBase64}`,

        },

      });

    }



    messages.push({

      role: "user",

      content: userContent,

    });



    // استدعاء OpenAI Chat Completions مباشرة عبر HTTP

    const response = await fetch("https://api.openai.com/v1/chat/completions", {

      method: "POST",

      headers: {

        "Content-Type": "application/json",

        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,

      },

      body: JSON.stringify({

        model: "gpt-4o-mini",

        messages,

        max_tokens: 600,

      }),

    });



    const data = await response.json();



    if (!response.ok) {

      console.error("OpenAI error:", response.status, data);

      return res.status(500).json({

        error: "openai_error",

        details: data,

      });

    }



    // أحياناً يكون الـ content عبارة عن string أو array

    let replyText = "FixLens Brain could not generate a response.";



    const msg = data.choices?.[0]?.message;

    if (msg) {

      if (typeof msg.content === "string") {

        replyText = msg.content;

      } else if (Array.isArray(msg.content)) {

        // ندمج كل مقاطع النص في رسالة واحدة

        replyText =

          msg.content

            .filter((c) => c.type === "text" && c.text)

            .map((c) => c.text)

            .join("\n\n") || replyText;

      }

    }



    return res.status(200).json({ reply: replyText });

  } catch (err) {

    console.error("FixLens API ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err.message,

    });

  }

}
