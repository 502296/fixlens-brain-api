import {
  buildDoctorSystemPrompt,
  buildUserInput,
  shouldWebSearch
} from "./doctorPrompt.js";

import { webSearchSerper } from "./lib/search.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.FIXLENS_TEXT_MODEL || "gpt-4.1-mini";
const TIMEOUT = 20000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TIMEOUT")), ms)
    )
  ]);
}

async function callOpenAI(system, input) {
  if (!OPENAI_KEY) throw new Error("NO_OPENAI_API_KEY");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      input: [
        { role: "system", content: [{ type: "text", text: system }] },
        { role: "user", content: [{ type: "text", text: input }] }
      ]
    })
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "OPENAI_ERROR");

  return (
    data.output_text ||
    data.output?.flatMap(o => o.content || [])
      .map(c => c.text)
      .join("\n")
  );
}

export async function textBrain({ message, history }) {
  let web = { ok: false, results: [] };

  if (shouldWebSearch(message)) {
    try {
      web = await webSearchSerper(message);
    } catch {}
  }

  const system = buildDoctorSystemPrompt();
  const input = buildUserInput({ message, history, web });

  try {
    const reply = await withTimeout(callOpenAI(system, input), TIMEOUT);
    return { reply };
  } catch (e) {
    return {
      reply:
        "I couldn’t generate a response right now. Please try again and include the car year, make, model, and what happens."
    };
  }
}
