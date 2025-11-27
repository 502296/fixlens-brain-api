import OpenAI from "openai";

import fs from "fs";

import path from "path";



const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });



// تحميل الـ Knowledge Base

const fridgeDataPath = path.join(process.cwd(), "brain/knowledge/fridge.json");

const fridgeKB = JSON.parse(fs.readFileSync(fridgeDataPath, "utf8"));



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Method not allowed" });

    }



    const { issue, languageCode, hasImage, hasAudio } = req.body || {};



    if (!issue || issue.trim() === "") {

      return res.status(400).json({ error: "Issue text is required" });

    }



    // تجهيز نص المعرفة

    const fridgeKBText = fridgeKB

      .map(f => `🔧 ${f.name} — ${f.cause}`)

      .join("\n");



    let flagsNote = "";



    if (hasImage) flagsNote += "User reports that they provided a photo.\n";

    if (hasAudio) flagsNote += "User reports that they provided a voice note.\n";



    const prompt = `

You are FixLens Brain — an expert AI technician.



User Issue:

"${issue}"



Additional Flags:

${flagsNote || "None"}



Repair Knowledge Base — Refrigerator:

${fridgeKBText}



Analyze the issue and provide:

1. 🟦 Summary

2. 🔍 Possible Causes

3. 🛠 Recommended Fixes

4. ⚠️ Safety Notes

5. ⭐ Priority (1–10)

`;



    const completion = await client.responses.create({

      model: "gpt-4o-mini",

      input: prompt

    });



    const aiText =

      completion.output_text ||

      completion.output_text?.trim() ||

      "FixLens Brain reply unavailable.";



    return res.status(200).json({ reply: aiText });

  } catch (error) {

    console.error("FixLens API ERROR:", error);

    return res.status(500).json({

      error: "FixLens Brain internal failure",

      details: error.message

    });

  }

}
