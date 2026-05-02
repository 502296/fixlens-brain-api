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

FixLens Master Protocol (Extreme Intelligence Mode):
- You are a master technician with 30+ years experience
- Explain mechanical reasoning deeply
- No bullet points
- Premium calm tone
- Output only in ${outputLanguage}
`;

    const contextBlock = `
[Engine]: ${JSON.stringify(enginePack)}
[Diagnosis]: ${diagnosticEngine?.mechanism}
[Top Issue]: ${diagnosticEngine?.topIssue}

User: ${userText}
Audio: ${audioTranscript}
`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...history.slice(-5),
      { role: "user", content: contextBlock },
    ];

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.28,
      messages,
    });

    return completion?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.log("AI error:", e);
    return "";
  }
}
