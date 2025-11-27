import fs from 'fs';

import path from 'path';

import OpenAI from 'openai';



const client = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY

});



// Load knowledge files dynamically

function loadKnowledge() {

  const knowledgeDir = path.join(process.cwd(), 'brain', 'knowledge');

  const files = fs.readdirSync(knowledgeDir);



  let allData = [];



  for (const file of files) {

    if (file.endsWith('.json')) {

      const filePath = path.join(knowledgeDir, file);

      const raw = fs.readFileSync(filePath, 'utf8');

      try {

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



// Simple matching engine

function findMatches(issueText) {

  if (!issueText || issueText.length < 2) return [];



  const text = issueText.toLowerCase();

  const matches = [];



  for (const item of KNOWLEDGE_BASE) {

    const score =

      (item.title?.toLowerCase().includes(text) ? 3 : 0) +

      (item.symptoms?.some(s => s.toLowerCase().includes(text)) ? 2 : 0);



    if (score > 0) {

      matches.push({

        ...item,

        score

      });

    }

  }



  return matches

    .sort((a, b) => b.score - a.score)

    .slice(0, 3);

}



export default async function handler(req, res) {

  if (req.method !== 'POST') {

    return res.status(405).json({ error: 'Only POST allowed' });

  }



  try {

    const { issue, hasImage, hasAudio, languageCode } = req.body;



    // 1) Retrieve top matches from knowledge

    const matches = findMatches(issue);



    let contextText = "No matches found in FixLens Knowledge Base.";

    if (matches.length > 0) {

      contextText = matches

        .map(

          m => `

### Possible Match: ${m.title}

Symptoms: ${m.symptoms?.join(', ')}

Possible Causes: ${m.possible_causes?.join(', ')}

Recommended Actions: ${m.recommended_actions?.join(', ')}

Severity: ${m.severity}

      `

        )

        .join('\n\n');

    }



    // 2) Construct the prompt for GPT-4o

    const prompt = `

You are FixLens Brain, an expert technician AI.



User issue:

"${issue}"



Image Provided: ${hasImage ? "YES" : "NO"}

Audio Provided: ${hasAudio ? "YES" : "NO"}



Below is internal FixLens expert knowledge (V2):

${contextText}



Using the knowledge + your own reasoning,

provide a clear, simple, step-by-step diagnosis.



Your answer MUST follow this structure:

1) Summary

2) Possible Causes

3) What To Check First

4) Step-by-Step Fix

5) Safety Warnings (if needed)



Answer in language code: ${languageCode}.

    `;



    // 3) Call GPT-4o

    const completion = await client.chat.completions.create({

      model: "gpt-4o-mini",

      messages: [

        { role: "system", content: "You are FixLens Brain V2." },

        { role: "user", content: prompt }

      ]

    });



    const reply = completion.choices[0]?.message?.content || "Diagnostic error.";



    return res.status(200).json({

      reply,

      matchesFound: matches.length

    });



  } catch (err) {

    console.error("FixLens ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error.",

      details: err.message

    });

  }

}
