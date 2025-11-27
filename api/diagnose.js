// api/diagnose.js

// -------------------------------------

// FixLens Brain V1  (Text + Knowledge Base)

// لا زال بدون تحليل صور/صوت حقيقي (flags فقط)

// -------------------------------------



import OpenAI from "openai";

import fs from "fs";

import path from "path";



const openai = new OpenAI({

  apiKey: process.env.OPENAI_API_KEY,

});



// ---------- تحميل ملفات الـ Knowledge Base ----------



function loadJson(relativePath) {

  try {

    const fullPath = path.join(process.cwd(), relativePath);

    const raw = fs.readFileSync(fullPath, "utf8");

    return JSON.parse(raw);

  } catch (err) {

    console.error("❌ Failed to load KB file:", relativePath, err);

    return [];

  }

}



// تأكد أن هذه الأسماء تطابق الملفات التي أنشأناها

const fridgeKb = loadJson("brain/knowledge/fridge.json");

const washerKb = loadJson("brain/knowledge/washer.json");

const washerExtraKb = loadJson("brain/knowledge/washer_extra.json");

const acKb = loadJson("brain/knowledge/ac.json");

const acExtraKb = loadJson("brain/knowledge/ac_extra.json");

const carKb = loadJson("brain/knowledge/car.json");



// نجمع كل شيء في مصفوفة واحدة

const ALL_KNOWLEDGE = [

  ...fridgeKb,

  ...washerKb,

  ...washerExtraKb,

  ...acKb,

  ...acExtraKb,

  ...carKb,

];



// ---------- دالة اختيار الأعطال الأقرب للمشكلة ----------



function scoreEntry(issueText, entry) {

  const text = issueText.toLowerCase();

  let score = 0;



  const fields = [];



  if (entry.title) fields.push(entry.title);

  if (Array.isArray(entry.symptoms)) {

    fields.push(entry.symptoms.join(" "));

  }

  if (Array.isArray(entry.possible_causes)) {

    fields.push(entry.possible_causes.join(" "));

  }



  const full = fields.join(" ").toLowerCase();



  // نقاط بسيطة حسب الكلمات

  const keywords = [

    "fridge",

    "refrigerator",

    "freezer",

    "wash",

    "washer",

    "washing machine",

    "laundry",

    "ac",

    "air conditioner",

    "cool",

    "heat",

    "car",

    "engine",

    "brake",

    "transmission",

    "overheat",

    "noise",

    "click",

    "leak",

    "water",

    "ice",

    "spin",

    "vibration",

  ];



  for (const word of keywords) {

    if (text.includes(word) && full.includes(word)) {

      score += 3;

    }

  }



  // زيادة نقاط لو جزء من العنوان أو الأعراض ظاهر في نص المستخدم

  if (entry.title && text.includes(entry.title.toLowerCase().split(" ")[0] || "")) {

    score += 2;

  }



  if (Array.isArray(entry.symptoms)) {

    for (const s of entry.symptoms) {

      const part = s.toLowerCase().split(" ").slice(0, 3).join(" ");

      if (part.length > 0 && text.includes(part)) {

        score += 2;

      }

    }

  }



  // لو نفس نوع العطل (فرن/ثلاجة/سيارة) مذكور في العنوان

  if (entry.id && text.includes("fridge") && entry.id.startsWith("fridge_")) score += 4;

  if (entry.id && text.includes("freezer") && entry.id.startsWith("fridge_")) score += 4;

  if (entry.id && text.includes("washer") && entry.id.startsWith("washer_")) score += 4;

  if (entry.id && text.includes("laundry") && entry.id.startsWith("washer_")) score += 4;

  if (entry.id && text.includes("ac") && entry.id.startsWith("ac_")) score += 4;

  if (entry.id && text.includes("air conditioner") && entry.id.startsWith("ac_")) score += 4;

  if (entry.id && text.includes("car") && entry.id.startsWith("car_")) score += 4;

  if (entry.id && text.includes("engine") && entry.id.startsWith("car_")) score += 2;



  return score;

}



function findBestMatches(issueText, maxItems = 5) {

  if (!issueText || !issueText.trim() || ALL_KNOWLEDGE.length === 0) {

    return [];

  }



  const scored = ALL_KNOWLEDGE.map((entry) => ({

    entry,

    score: scoreEntry(issueText, entry),

  }));



  scored.sort((a, b) => b.score - a.score);



  const filtered = scored.filter((x) => x.score > 0);



  return filtered.slice(0, maxItems).map((x) => x.entry);

}



function buildKnowledgeContext(matches) {

  if (!matches || matches.length === 0) return "";



  const blocks = matches.map((m, index) => {

    const title = m.title || "Unknown issue";

    const symptoms = Array.isArray(m.symptoms) ? m.symptoms.join("; ") : "";

    const causes = Array.isArray(m.possible_causes)

      ? m.possible_causes.join("; ")

      : "";

    const actions = Array.isArray(m.recommended_actions)

      ? m.recommended_actions.join("; ")

      : "";



    return [

      `#${index + 1} • ${title}`,

      symptoms ? `- Symptoms: ${symptoms}` : "",

      causes ? `- Possible causes: ${causes}` : "",

      actions ? `- Recommended actions: ${actions}` : "",

    ]

      .filter(Boolean)

      .join("\n");

  });



  return blocks.join("\n\n");

}



// ---------- الـ Handler الرئيسي ----------



export default async function handler(req, res) {

  try {

    if (req.method !== "POST") {

      return res.status(405).json({ error: "Only POST allowed" });

    }



    const {

      issue,

      languageCode = "en",

      hasImage, // حالياً فقط فلاغ - بدون تحليل حقيقي

      hasAudio, // حالياً فقط فلاغ - بدون تحليل حقيقي

    } = req.body || {};



    if (!issue || typeof issue !== "string" || !issue.trim()) {

      return res.status(400).json({

        error: "You must provide an 'issue' text description.",

      });

    }



    // 1) نبحث في قاعدة المعرفة عن أعطال مشابهة

    const matches = findBestMatches(issue);

    const kbText = buildKnowledgeContext(matches);



    // 2) نبني الرسائل للـ GPT

    const messages = [];



    // SYSTEM: تعريف FixLens Brain + طريقة استخدام الـ Knowledge Base

    messages.push({

      role: "system",

      content: [

        {

          type: "text",

          text:

            "You are FixLens Brain, an AI technician for fridges, washers, AC units, and cars. " +

            "You MUST first reason using the internal FixLens Knowledge Base if relevant, then use your general intelligence (GPT) on top of it. " +

            "Explain clearly, step-by-step, with practical checks the user can do safely at home. " +

            "If something is dangerous or high risk, clearly warn the user to stop and call a professional.",

        },

      ],

    });



    // SYSTEM: نضيف جزء الـ Knowledge Base لو وجدنا مطابقات

    if (kbText) {

      messages.push({

        role: "system",

        content: [

          {

            type: "text",

            text:

              "Here are some structured issues from the FixLens internal Repair Knowledge Base " +

              "that may match the user's description. Use them as primary reference:\n\n" +

              kbText,

          },

        ],

      });

    }



    // USER: وصف المشكلة من المستخدم (النص الأساسي)

    messages.push({

      role: "user",

      content: [

        {

          type: "text",

          text:

            `User language code: ${languageCode}.\n` +

            (hasImage ? "[User also attached a photo of the issue.]" : "") +

            (hasAudio

              ? "\n[User also attached a voice note describing the sound/problem.]"

              : "") +

            "\n\nUser description:\n" +

            issue,

        },

      ],

    });



    // 3) استدعاء GPT-4o-mini

    const completion = await openai.chat.completions.create({

      model: "gpt-4o-mini",

      messages,

      max_tokens: 700,

    });



    const reply =

      completion.choices?.[0]?.message?.content ||

      "FixLens Brain could not generate a response.";



    // ممكن نرجع IDs للأعطال المستخدمة لو حابب نستخدمها لاحقاً

    const usedIds = matches.map((m) => m.id || null).filter(Boolean);



    return res.status(200).json({

      reply,

      usedKnowledgeIds: usedIds,

    });

  } catch (err) {

    console.error("FixLens Brain V1 ERROR:", err);

    return res.status(500).json({

      error: "FixLens Brain internal error",

      details: err.message,

    });

  }

}
