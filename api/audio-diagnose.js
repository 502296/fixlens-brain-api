import fs from "fs";

import path from "path";

import OpenAI from "openai";



// Initialize OpenAI client

const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY

});



// Load knowledge base dynamically

function loadKnowledge() {

  const knowledgeDir = path.join(process.cwd(), "brain", "knowledge");

  const files = fs.readdirSync(knowledgeDir);



  let allData = [];



  for (const file of files) {

    if (file.endsWith(".json")) {

      const filePath = path.join(knowledgeDir, file);

      try {

        const raw = fs.readFileSync(filePath, "utf8");

        const json = JSON.parse(raw);

        allData = allData.concat(json);

      } catch (e) {

        console.error(`Error parsing ${file}:`, e);

      }

    }

  }



  return allData;

}



const KNOWLEDGE_BASE = loadKnowledge();



// Matching engine

function findMatches(text) {

  if (!text || text.length < 2) return [];



  const t = text.toLowerCase();

  const matches = [];



  for (const item of KNOWLEDGE_BASE) {

    const score =

      (item.title?.toLowerCase().includes(t) ? 3 : 0) +

      (item.symptoms?.some((s) => s.toLowerCase().includes(t)) ? 2 : 0);



    if (score > 0) {

      matches.push({ ...item, score });

    }

  }



  return matches.sort((a, b) => b.score - a.score).slice(0, 3);

}



export const config = {

  api: {

    bodyParser: false, // Important for receiving audio files

  },

};



export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Only POST allowed." });

  }



  try {

    // Parse audio file from request

    const audioChunks = [];



    req.on("data", (chunk) => audioChunks.push(chunk));

    req.on("end", async () => {

      const audioBuffer = Buffer.concat(audioChunks);



      if (!audioBuffer || audioBuffer.length < 2000) {

        return res.status(400).json({ error: "Audio file missing or too small." });

      }



      // ---- 1) Transcribe using Whisper / GPT-4o ----

      const transcription = await client.audio.transcriptions.create({

        file: audioBuffer,

        model: "gpt-4o-mini-tts",

        response_format: "text"

      });



      const text = transcription || "";

      console.log("🎧 Transcribed Text:", text);



      // ---- 2) Match against knowledge base ----

      const matches = findMatches(text);



      let contextText = "No internal knowledge match.";

      if (matches.length > 0) {

        contextText = matches

          .map(

            (m) => `

### Match: ${m.title}

Symptoms: ${m.symptoms?.join(", ")}

Possible Causes: ${m.possible_causes?.join(", ")}

Recommended: ${m.recommended_actions?.join(", ")}

Severity: ${m.severity}

`

          )

          .join("\n\n");

      }



      // ---- 3) Diagnose using FixLens Brain ----

      const prompt = `

You are FixLens Brain V2 (Audio Mode).

User voice transcription: "${text}"



Internal Knowledge:

${contextText}



Give a professional diagnosis with:

1) Summary

2) Possible Causes

3) What To Check First

4) Step-by-Step Fix

5) Safety Warnings

`;



      const completion = await client.chat.completions.create({

        model: "gpt-4o-mini",

        messages: [

          { role: "system", content: "You are FixLens Audio Brain." },

          { role: "user", content: prompt }

        ]

      });



      const reply = completion.choices[0].message.content;



      return res.status(200).json({

        transcript: text,

        reply,

        matchesFound: matches.length

      });

    });

  } catch (err) {

    console.error("Audio Engine Error:", err);

    return res.status(500).json({

      error: "Audio diagnose failed.",

      details: err.message,

    });

  }

}
