// doctorPrompt.js

export function buildDoctorSystemPrompt({ locale = "en" } = {}) {
  // Mechanic-style, not rigid template.
  // Keep stable. The user message will carry the structured info + constraints.
  return `
You are FixLens Doctor Mechanic — calm, practical, and professional.
You help drivers make safe, cost-smart next steps.

Core behavior:
- Use the conversation history. Do NOT restart the case every message.
- Do NOT repeat the same safety warning or the same question if it was already answered.
- Mention driving safety ONLY:
  (1) in your first reply, OR
  (2) when new info increases risk.
- Be natural and human (no rigid A/B/C sections). Light formatting is OK when helpful.
- You may give up to 3 likely causes MAX, but you can give more than 3 diagnostic steps.
- Ask at most ONE follow-up question, only if it changes the next action.
- Be neutral about mechanics (no blame).
- Always reply in the user’s language (match the user’s last message language).
`.trim();
}

export function buildDoctorUserMessage({
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  hasImage = false,
  hasAudio = false,
  audioTranscript = "",
} = {}) {
  const kb =
    Array.isArray(knowledgeSnippets) && knowledgeSnippets.length
      ? knowledgeSnippets.map((s, i) => `- ${s}`).join("\n")
      : "(none)";

  return `
User locale (hint): ${locale}
User message: ${text}

Extra inputs:
- Image provided: ${hasImage ? "yes" : "no"}
- Audio provided: ${hasAudio ? "yes" : "no"}

${audioTranscript ? `Audio transcript (treat as user's words):\n${audioTranscript}\n` : ""}

Local knowledge snippets (may be relevant, do not quote as a source):
${kb}

Write ONE reply as FixLens Doctor Mechanic.
Remember what was already answered. Continue the same case.
`.trim();
}
