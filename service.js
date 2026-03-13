// service.js — FixLens Brain v6
// Main Orchestrator

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./memoryEngine.js";
import { buildResponsePlan } from "./responsePlanner.js";
import { buildEnginePack } from "./engineInteL.js";
import { detectIntent } from "./intentDetector.js";
import { processAudio } from "./audioProcessor.js";
import { performSearch } from "./search.js";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

const MODEL = process.env.FIXLENS_MODEL || "gpt-4o";

export async function handleFixLensRequest(req) {
const body = req?.body || {};

const text = String(body.text || body.message || "").trim();

const history = Array.isArray(body.history) ? body.history : [];

const image = body.image_base64 || "";
const audio = body.audio_base64 || "";

/* -------------------------
AUDIO
-------------------------- */
const audioResult = await processAudio({
audio,
locale: body.locale,
});

const voiceText = String(audioResult?.text || "").trim();

const userText = `${text} ${voiceText}`.trim();

/* -------------------------
MEMORY
-------------------------- */
const diagnosticMemory = buildDiagnosticMemory({
text: userText,
history,
});

/* -------------------------
INTENT
-------------------------- */
const intent = detectIntent({
text: userText,
history,
});

/* -------------------------
ENGINE INTEL
-------------------------- */
const enginePack = buildEnginePack(userText);

/* -------------------------
SEARCH
-------------------------- */
let verifiedData = [];
let workshops = [];

if (intent?.needsSearch) {
const searchResult = await performSearch(
userText,
body.user_location || body.location || null
);

verifiedData = Array.isArray(searchResult?.verified_data)
? searchResult.verified_data
: [];

workshops = Array.isArray(searchResult?.verified_workshops)
? searchResult.verified_workshops
: [];
}

/* -------------------------
RESPONSE PLAN
-------------------------- */
const planner = buildResponsePlan({
text: userText,
enginePack,
memory: diagnosticMemory,
verifiedData,
});

/* -------------------------
PROMPT
-------------------------- */
const systemPrompt = buildDoctorSystemPrompt();

const userBlock = `
USER_INPUT:
${userText}

IMAGE_ATTACHED:
${image ? "true" : "false"}

ENGINE_CONTEXT:
${JSON.stringify(enginePack)}

MEMORY:
${diagnosticMemory?.memory_text || ""}

PLAN:
${planner?.planner_text || ""}

DATA:
${JSON.stringify(verifiedData)}
`.trim();

const response = await client.responses.create({
model: MODEL,
instructions: systemPrompt,
input: [
...history.map((item) => ({
role: item?.role === "assistant" ? "assistant" : "user",
content: String(item?.content || ""),
})),
{
role: "user",
content: userBlock,
},
],
temperature: 0.2,
max_output_tokens: 900,
});

const reply =
typeof response?.output_text === "string" && response.output_text.trim()
? response.output_text.trim()
: "Diagnosis unclear.";

return {
ok: true,
reply,
workshops_count: workshops.length,
};
}
