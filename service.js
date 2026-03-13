// service.js — FixLens Brain v6
// Main Orchestrator

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./brain/memoryEngine.js";
import { buildResponsePlan } from "./brain/responsePlanner.js";
import { buildEnginePack } from "./brain/engineIntel.js";
import { detectIntent } from "./brain/intentDetector.js";

import { processAudio } from "./audio/audioProcessor.js";
import { performSearch } from "./search/search.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL =
  process.env.FIXLENS_MODEL ||
  "gpt-4o";

export async function handleFixLensRequest(req) {

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

  /* -------------------------
     AUDIO
  -------------------------- */

  const audioResult = await processAudio({
    audio,
    locale: body.locale
  });

  const voiceText =
    audioResult.text || "";

  const userText =
    `${text} ${voiceText}`.trim();

  /* -------------------------
     MEMORY
  -------------------------- */

  const diagnosticMemory =
    buildDiagnosticMemory({
      text: userText,
      history
    });

  /* -------------------------
     INTENT
  -------------------------- */

  const intent =
    detectIntent({
      text: userText,
      history
    });

  /* -------------------------
     ENGINE INTEL
  -------------------------- */

  const enginePack =
    buildEnginePack(userText);

  /* -------------------------
     SEARCH
  -------------------------- */

  let verifiedData = [];
  let workshops = [];

  if (intent.needsSearch) {

    const searchResult =
      await performSearch(
        userText,
        body.user_location
      );

    verifiedData =
      searchResult.verified_data || [];

    workshops =
      searchResult.verified_workshops || [];
  }

  /* -------------------------
     RESPONSE PLAN
  -------------------------- */

  const planner =
    buildResponsePlan({
      text: userText,
      enginePack,
      memory: diagnosticMemory,
      verifiedData
    });

  /* -------------------------
     PROMPT
  -------------------------- */

  const systemPrompt =
    buildDoctorSystemPrompt();

  const userBlock = `
USER_INPUT:
${userText}

ENGINE_CONTEXT:
${JSON.stringify(enginePack)}

MEMORY:
${diagnosticMemory.memory_text}

PLAN:
${planner.planner_text}

DATA:
${JSON.stringify(verifiedData)}
`;

  const response =
    await client.responses.create({

      model: MODEL,

      instructions: systemPrompt,

      input: [
        ...history,
        {
          role: "user",
          content: userBlock
        }
      ],

      temperature: 0.2,

      max_output_tokens: 900

    });

  const reply =
    response.output_text ||
    "Diagnosis unclear.";

  return {

    ok: true,
    reply,

    workshops_count:
      workshops.length

  };
}
