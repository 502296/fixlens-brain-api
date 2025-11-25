// /api/diagnose.js



import OpenAI from "openai";



export const config = {

  runtime: "edge",

};



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



// -------------------------------------------------------------

// Helper: Detect language of user so FixLens replies same language

// -------------------------------------------------------------

async function detectLanguage(text) {

  try {

    const response = await client.responses.create({

      model: "gpt-4o-mini",

      input: `Detect the language of the following text and answer only with the language name:\n\n${text}`,

    });



    return response.output_text.trim() || "English";

  } catch {

    return "English";

  }

}



// -------------------------------------------------------------

// Helper: Format the final FixLens answer

// -------------------------------------------------------------

function formatFinalAnswer({ language, diagnosis, steps, warning }) {

  if (language === "Arabic") {

    return `

🔧 **تشخيص FixLens:**

${diagnosis}



📌 **الخطوات المقترحة للإصلاح:**

${steps}



⚠️ **تنبيه مهم:**

${warning}

    `.trim();

  }



  return `

🔧 **FixLens Diagnosis**

${diagnosis}



📌 **Recommended Steps**

${steps}



⚠️ **Important Safety Note**

${warning}

  `.trim();

}



// -------------------------------------------------------------

// Main handler

// -------------------------------------------------------------

export default async function handler(req) {

  try {

    const body = await req.json();



    const { userMessage, category, uiLanguage, hasImage } = body;



    const prompt = userMessage?.trim() || "";

    const lang = uiLanguage || (await detectLanguage(prompt));



    // ---------------------------------------------------------

    // 1) Choose model automatically

    // ---------------------------------------------------------

    let modelToUse = "gpt-4o-mini";



    if (hasImage) {

      modelToUse = "gpt-4o";

    } else if (prompt.length > 250) {

      modelToUse = "gpt-4o";

    } else if (

      prompt.includes("won't start") ||

      prompt.includes("leaking") ||

      prompt.includes("burning") ||

      prompt.includes("danger") ||

      prompt.includes("fire") ||

      prompt.includes("gas") ||

      prompt.includes("explosion")

    ) {

      modelToUse = "gpt-4o-reasoning";

    }



    // ---------------------------------------------------------

    // 2) Build instruction for FixLens Brain

    // ---------------------------------------------------------

    const systemPrompt = `

You are FixLens Brain — an AI technician expert in Auto, Home, and Appliances.

Your mission:

1. Give accurate diagnosis.

2. Always provide step-by-step instructions.

3. Always include a safety warning.

4. Stay short, clear, and professional.

5. Write the answer in the user's language: ${lang}.

6. If unclear, ask one clarifying question.

7. Never hallucinate. Never invent things.

8. If the user uploads a photo, analyze it visually with high precision.

    `.trim();



    // ---------------------------------------------------------

    // 3) Call the chosen model

    // ---------------------------------------------------------

    const response = await client.responses.create({

      model: modelToUse,

      input: [

        {

          role: "system",

          content: systemPrompt,

        },

        {

          role: "user",

          content: prompt,

        },

      ],

    });



    const raw = response.output_text || "I could not generate a diagnosis.";



    // ---------------------------------------------------------

    // 4) Parse into sections: diagnosis + steps + safety warning

    // ---------------------------------------------------------

    const diagnosis =

      raw.match(/Diagnosis:(.*)/i)?.[1]?.trim() ||

      raw.match(/تشخيص:(.*)/i)?.[1]?.trim() ||

      raw;



    const steps =

      raw.match(/Steps:(.*)/i)?.[1]?.trim() ||

      raw.match(/الخطوات:(.*)/i)?.[1]?.trim() ||

      "-";



    const warning =

      raw.match(/Warning:(.*)/i)?.[1]?.trim() ||

      raw.match(/تحذير:(.*)/i)?.[1]?.trim() ||

      "Always follow safety procedures.";



    // ---------------------------------------------------------

    // 5) Build final formatted reply

    // ---------------------------------------------------------

    const finalReply = formatFinalAnswer({

      language: lang,

      diagnosis,

      steps,

      warning,

    });



    return new Response(JSON.stringify({ reply: finalReply }), {

      status: 200,

      headers: { "Content-Type": "application/json" },

    });

  } catch (err) {

    return new Response(

      JSON.stringify({ error: String(err) }),

      { status: 500 }

    );

  }

}
