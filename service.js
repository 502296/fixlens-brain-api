// doctorPrompt.js
// FixLens Doctor Mechanic Pro — FINAL (session-aware intake)
// Compatible with service.js import { buildDoctorMessages }

export function buildDoctorMessages({
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  searchSnippets = [],
  hasImage = false,
  hasAudio = false,
  audioTranscript = "",
  alreadyAskedIntake = false,
} = {}) {
  const AUTO = Array.isArray(knowledgeSnippets) && knowledgeSnippets.length
    ? `\nAUTO_KNOWLEDGE:\n${knowledgeSnippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
    : "";

  const WEB = Array.isArray(searchSnippets) && searchSnippets.length
    ? `\nWEB_SEARCH_SNIPPETS:\n${searchSnippets.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`
    : "";

  const AUDIO = hasAudio && audioTranscript
    ? `\nAUDIO_TRANSCRIPT:\n${audioTranscript}\n`
    : "";

  const MODE = hasImage ? "IMAGE" : hasAudio ? "AUDIO" : "TEXT";

  const sys = `
You are FixLens — a calm, professional “doctor mechanic” second-opinion assistant for car problems.

Language (hard rule):
- Reply fully in the user’s language. Never mix languages.

Style:
- Use numbered points and short sections.
- Slightly deeper than surface, but practical.
- Max 3 causes (ranked).
- Always include "Safe to drive?" clearly.
- Provide 3–6 next steps (include ONE discriminating check).
- Ask at most ONE follow-up question.

Session-aware intake rule:
- Ask for year + make/model and when it happens ONLY IF it is missing AND ONLY IF alreadyAskedIntake=false.
- If alreadyAskedIntake=true, do NOT ask the intake question again.

Web search (shops/addresses):
- If user asks for nearby shops/addresses: provide EXACTLY 3 options formatted:
  Name — Address — (optional phone/website)
- Do not refuse, do not tell user to search themselves.
`;

  const user = `
MODE: ${MODE}
alreadyAskedIntake: ${alreadyAskedIntake}

USER_TEXT:
${text || ""}

${AUTO}
${WEB}
${AUDIO}

OUTPUT FORMAT:
0) Professional opening line (one short line)
1) What I think is happening (1–2 lines; mention 1–2 clues)
2) Likely causes (ranked 1–3)
3) Safe to drive? (Yes/No + reason + rule)
4) What to do next (3–6 steps)
5) One follow-up question (optional; max one; obey session-aware intake rule)
`;

  return [
    { role: "system", content: sys.trim() },
    { role: "user", content: user.trim() },
  ];
}

// Optional alias
export function buildDoctorSystemPrompt() {
  return buildDoctorMessages();
}
