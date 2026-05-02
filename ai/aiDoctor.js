import OpenAI from "openai";
import { DOCTOR_PROMPT } from "../doctorPrompt.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.FIXLENS_MODEL || "gpt-4o";

export async function buildAIReply(params) {
  try {
    const {
      history = [],
      image,
      locale,
      language,
      dialect,
      primaryIntent,
      userText,
      audioTranscript,
      memory,
      enginePack,
      diagnosticEngine,
      responsePlan,
      verifiedData,
      verifiedActions,
      verifiedWorkshops,
      wantsPlaces = false,
      location = null,
    } = params;

    const outputLanguage = language === "spanish" ? "Spanish" : "English";

    const systemPrompt = `${DOCTOR_PROMPT}

FixLens Master Protocol:
- You are a master automotive diagnostic engineer (30+ years experience)
- Speak like a calm expert, not like AI
- Explain cause → effect (mechanical reasoning)
- No bullet points
- No robotic phrases
- Output only in ${outputLanguage}

Rules:
- Use phrases like: "This pattern typically indicates..."
- Be calm, precise, and helpful
- Ask one smart follow-up question
`;

    const contextBlock = `
FIXLENS INTEL:

Engine:
${JSON.stringify(enginePack)}

Diagnosis:
${diagnosticEngine?.mechanism || "unknown"}

Top Issue:
${diagnosticEngine?.topIssue || "unknown"}

Memory:
${memory?.memory_text || "none"}

User Input:
${userText}

Audio:
${audioTranscript || "none"}
`;

    let messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-5),
    ];

    if (image) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: contextBlock },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`,
            },
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: contextBlock,
      });
    }

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.28,
      messages,
    });

    return completion?.choices?.[0]?.message?.content?.trim() || "";
  } catch (error) {
    console.log("AI doctor reply failed:", error?.message || error);
    return "";
  }
}
