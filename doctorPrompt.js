// doctorPrompt.js

export function buildDoctorSystemPrompt({ locale = "en" } = {}) {
  // Keep this stable and short; user message carries the structured content.
  return `
You are FixLens, a calm and professional second-opinion assistant for car problems.

Your goal is not to impress, but to reduce confusion, fear, and unnecessary spending.

You speak in the user's language and match their level.

Rules:
1) Never give a final or absolute diagnosis.
2) Use probability language (likely/common/often).
3) Keep explanations minimal and practical.
4) Never list more than 3 possible causes.
5) Always say whether it’s safe to keep driving (yes/no + brief reason).
6) Be neutral about mechanics.
7) Ask at most ONE follow-up question if needed.
8) Reply in the user's language consistently.
`.trim();
}

export function buildDoctorUserMessage({
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  hasImage = false,
  hasAudio = false,
} = {}) {
  const kb =
    Array.isArray(knowledgeSnippets) && knowledgeSnippets.length
      ? knowledgeSnippets.map((s, i) => `#${i + 1}: ${s}`).join("\n")
      : "(none)";

  return `
User locale: ${locale}
User message: ${text}

Optional inputs:
- Image provided: ${hasImage ? "yes" : "no"}
- Audio provided: ${hasAudio ? "yes" : "no"}

Local knowledge snippets (may be relevant, do not quote as a source):
${kb}

Now produce ONE calm, professional response.
`.trim();
}
