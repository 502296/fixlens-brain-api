// service.js — FixLens Brain v7 (Clean Stable Orchestrator)

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./memoryEngine.js";
import { buildResponsePlan } from "./responsePlanner.js";
import { buildEnginePack } from "./engineIntel.js";
import { detectIntent } from "./IntentDetector.js";

import { processAudio } from "./audioProcessor.js";
import { performSearch } from "./search.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL =
  process.env.FIXLENS_MODEL ||
  "gpt-4o";

export async function handleFixLensRequest(req) {

  try {

    const body = req.body || {};

    const text =
      body.text ||
      body.message ||
      "";

    const history =
      Array.isArray(body.history)
        ? body.history
        : [];

    const image =
      body.image_base64 || "";

    const audio =
      body.audio_base64 || "";

    const location =
      body.location ||
      body.user_location ||
      null;

    let userText = text;

    /* -------------------------
       AUDIO PROCESSING
    ------------------------- */

    if (audio) {

      try {

        const audioText = await processAudio(audio);

        if (audioText) {
          userText = audioText;
        }

      } catch (e) {
        console.log("Audio processing failed:", e.message);
      }

    }

    if (!userText) {
      return {
        reply: "Please describe the problem you are experiencing with the vehicle.",
        intent: "unknown"
      };
    }

    /* -------------------------
       INTENT DETECTION
    ------------------------- */

    let intent = "diagnostic";

    try {
      intent = detectIntent(userText);
    } catch (e) {
      console.log("Intent detection failed");
    }

    /* -------------------------
       MEMORY ENGINE
    ------------------------- */

    let memoryBlock = "";

    try {
      memoryBlock = buildDiagnosticMemory({
        text: userText,
        history
      });
    } catch (e) {
      console.log("Memory engine failed");
    }

    /* -------------------------
       ENGINE INTELLIGENCE
    ------------------------- */

    let engineIntel = "";

    try {
      engineIntel = buildEnginePack(userText);
    } catch (e) {
      console.log("Engine intel failed");
    }

    /* -------------------------
       WEB SEARCH
    ------------------------- */

    let searchResults = "";

    try {

      if (intent === "places" || intent === "repair" || intent === "nearby") {

        const search = await performSearch({
          query: userText,
          location
        });

        searchResults = JSON.stringify(search);

      }

    } catch (e) {
      console.log("Search failed");
    }

    /* -------------------------
       RESPONSE PLAN
    ------------------------- */

    let responsePlan = "";

    try {

      responsePlan = buildResponsePlan({
        text: userText,
        intent,
        memory: memoryBlock
      });

    } catch (e) {
      console.log("Response planner failed");
    }

    /* -------------------------
       SYSTEM PROMPT
    ------------------------- */

    const systemPrompt = buildDoctorSystemPrompt();

    /* -------------------------
       USER CONTEXT
    ------------------------- */

    let contextBlock = `
User Problem:
${userText}

Intent:
${intent}

Memory:
${memoryBlock}

Engine Intelligence:
${engineIntel}

Search Results:
${searchResults}

Response Plan:
${responsePlan}
`;

    /* -------------------------
       IMAGE SUPPORT
    ------------------------- */

    let messages = [
      {
        role: "system",
        content: systemPrompt
      }
    ];

    if (history.length > 0) {
      messages = messages.concat(history);
    }

    if (image) {

      messages.push({
        role: "user",
        content: [
          { type: "text", text: contextBlock },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`
            }
          }
        ]
      });

    } else {

      messages.push({
        role: "user",
        content: contextBlock
      });

    }

    /* -------------------------
       OPENAI CALL
    ------------------------- */

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.4,
      messages
    });

    const reply =
      completion?.choices?.[0]?.message?.content ||
      "I couldn't generate a diagnostic answer.";

    return {
      reply,
      intent
    };

  } catch (error) {

    console.error("FixLens service error:", error);

    return {
      reply: "FixLens encountered an internal error while analyzing the request.",
      intent: "error"
    };

  }

}
