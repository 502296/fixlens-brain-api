// service.js — FixLens Brain API (GPT-5 FINAL)

import OpenAI from "openai";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { webSearchSerper } from "./lib/search.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MAX_OUTPUT_TOKENS = 700;

export async function handleFixLensRequest(req, res) {
  try {
    const {
      text = "",
      locale = "en",
      alreadyAskedIntake = false,
      imageBase64 = null,
      imageMime = null,
    } = req.body || {};

    // 1️⃣ Auto knowledge
    const knowledgeSnippets = buildKnowledgeSnippets(text, locale);

    // 2️⃣ Web search (only if user asks)
    let searchSnippets = [];
    if (/near me|shop|garage|address/i.test(text)) {
      const r = await webSearchSerper(text, { gl: "us", hl: "en", num: 3 });
      if (r?.results?.length) {
        searchSnippets = r.results.map(
          (x) => `${x.title} — ${x.address || ""}`
        );
      }
    }

    // 3️⃣ Build prompts (from doctorPrompt.js)
    const msgs = buildDoctorMessages({
      text,
      knowledgeSnippets,
      searchSnippets,
      alreadyAskedIntake,
      hasImage: Boolean(imageBase64),
    });

    const systemText = msgs.find((m) => m.role === "system")?.content || "";
    const userText = msgs.find((m) => m.role === "user")?.content || "";

    // 🔥 GPT-5 REQUIRES A SINGLE STRING INPUT
    let finalPrompt = `
${systemText}

${userText}
`.trim();

    // 4️⃣ Call GPT-5
    const response = await client.responses.create({
      model: process.env.FIXLENS_MODEL || "gpt-5",
      input: finalPrompt, // ✅ STRING ONLY
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    const reply =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      "";

    if (!reply) {
      throw new Error("Empty GPT-5 response");
    }

    return res.json({
      ok: true,
      reply,
      model: "gpt-5",
    });
  } catch (err) {
    console.error("handleFixLensRequest error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "FixLens error",
    });
  }
}
