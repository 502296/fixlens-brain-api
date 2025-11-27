import fs from "fs";

import path from "path";

import OpenAI from "openai";



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



// -----------------------------

// LOAD KNOWLEDGE BASE

// -----------------------------

function loadKnowledge() {

  const knowledgeDir = path.join(process.cwd(), "brain", "knowledge");

  const files = fs.readdirSync(knowledgeDir);



  let allData = [];



  for (const file of files) {

    if (file.endsWith(".json")) {

      const filePath = path.join(knowledgeDir, file);

      const raw = fs.readFileSync(filePath, "utf8");



      try {

        const json = JSON.parse(raw);

        allData = allData.concat(json);

      } catch (e) {

        console.error("Error parsing knowledge file", file, e);

      }

    }

  }



  return allData;

}



const KNOWLEDGE = loadKnowledge();



// -----------------------------

// MATCHING ENGINE

// -----------------------------

function findMatches(issueText) {

  if (!issueText || issueText.length < 2) return [];



  const text = issueText.toLowerCase();

  const matches = [];



  for (const item of KNOWLEDGE) {

    const score =

      (item.title?.toLowerCase().includes(text) ? 3 : 0) +

      (item.symptoms?.some((s) => s.toLowerCase().includes(text)) ? 2 : 0);



    if (score > 0) {

      matches.push({ ...item, score });

    }

  }



  return matches.sort((a, b) => b.score - a.score).slice(0, 4);

}



// -----------------------------

// IMAGE ANALYZER (Vision)

// -----------------------------

async function analyzeImage(imageBase64) {

  if (!imageBase64) return null;



  try {

    const result = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        {

          role: "system",

          content: "You are FixLens Vision V2. Describe the problem in the image precisely.",

        },

        {

          role: "user",

          content: [

            {

              type: "input_image",

              image_url: `data:image/jpeg;base64,${imageBase64}`,

            },

          ],

        },

      ],

    });



    return result.choices[0]?.message?.content || null;

  } catch (err) {

    console.error("Vision Error:", err);

    return null;

  }

}



// -----------------------------

// AUDIO ANALYZER

// -----------------------------

async function transcribeAudio(audioBase64) {

  if (!audioBase64) return null;



  try {

    const buffer = Buffer.from(audioBase64, "base64");



    const transcription = await client.audio.transcriptions.create({

      file: buffer,

      model: "gpt-4o-mini-tts",

    });



    return transcription.text || null;

  } catch (err) {

    console.error("Audio Error:", err);

    return null;

  }

}



// -----------------------------

// MAIN HANDLER

// -----------------------------

export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({ error: "Only POST allowed" });

  }



  try {

    const { issue, imageBase64, audioBase64, languageCode } = req.body;



    // -----------------------------

    // Fallback processing

    // -----------------------------

    let finalIssue = issue || "";



    // Vision

    let visionInsight = null;

    if (imageBase64) {

      visionInsight = await analyzeImage(imageBase64);

    }



    // Audio → Text

    let audioText = null;

    if (audioBase64) {

      audioText = await transcribeAudio(audioBase64);

    }



    // Enhance issue with vision/audio insight

    if (visionInsight) finalIssue += `\n\nImage Analysis: ${visionInsight}`;

    if (audioText) finalIssue += `\n\nAudio Description: ${audioText}`;



    // -----------------------------

    // Knowledge Matching

    // -----------------------------

    const matches = findMatches(finalIssue);

    const context =

      matches.length > 0

        ? matches

            .map(

              (m) => `

### ${m.title}

Symptoms: ${m.symptoms?.join(", ")}

Possible Causes: ${m.possible_causes?.join(", ")}

Recommended Actions: ${m.recommended_actions?.join(", ")}

Severity: ${m.severity}

`

            )

            .join("\n\n")

        : "No matches found in FixLens Knowledge Base.";



    // -----------------------------

    // AI DIAGNOSIS

    // -----------------------------

    const prompt = `

You are FixLens Brain V3 — the world's first AI technician.



User Description:

${finalIssue}



Knowledge Base:

${context}



Now produce a professional FixLens Diagnosis:



1) Summary  

2) Possible Causes  

3) What To Check First  

4) Step-by-Step Fix  

5) Safety Warnings  



Language: ${languageCode}

    `;



    const output = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        { role: "system", content: "You are FixLens Brain V3 with expert repair logic." },

        { role: "user", content: prompt },

      ],

    });



    const reply = output.choices[0]?.message?.content || "Diagnostic Error.";



    return res.status(200).json({

      reply,

      matchesFound: matches.length,

      visionInsight,

      audioText,

    });

  } catch (err) {

    console.error("FixLens Error:", err);

    return res.status(500).json({

      error: "FixLens Brain internal failure.",

      details: err.message,

    });

  }

}
