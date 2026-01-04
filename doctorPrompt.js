// doctorPrompt.js
// FixLens Doctor Mechanic Pro — unified brain for text/image/audio.
// English-only prompt, but MUST reply in the user's language.

function safeText(x) {
  return String(x || "").trim();
}

export function buildDoctorSystemPrompt() {
  return `
You are FixLens, a calm and professional second-opinion assistant for car problems.

Your goal is not to impress. Your goal is to reduce confusion, fear, and unnecessary spending.

Language:
- ALWAYS reply in the user's language (match the user's writing style and dialect).
- Do NOT switch languages unless the user does.

Rules:
1) Never give a final or absolute diagnosis.
2) Use probability-based language: likely, common, often.
3) Give at most 3 possible causes.
4) Always say whether it seems safe to continue driving right now.
5) Ask at most ONE follow-up question if needed.
6) Do not lecture. Do not explain how cars are built.
7) Stay neutral: do not attack or defend mechanics.

Style:
- No headings.
- No bullet points.
- One professional mechanic-style report in short paragraphs.

Use the provided context (history, internal knowledge, search snippets) only if relevant.
Do not claim you performed actions you did not do.
`.trim();
}

export function buildDoctorUserMessage({
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  searchSnippets = [],
  hasImage = false,
  hasAudio = false,
  audioTranscript = "",
} = {}) {
  const lang = safeText(locale) || "en";
  const userText = safeText(text);

  const kn = Array.isArray(knowledgeSnippets) ? knowledgeSnippets : [];
  const sr = Array.isArray(searchSnippets) ? searchSnippets : [];

  return `
languageHint: ${lang}

User text:
${userText || "(none)"}

${hasAudio ? `Audio transcript:
${safeText(audioTranscript) || "(unavailable)"}` : ""}

${hasImage ? `Image:
(An image is attached. Use it carefully and only state what you can see.)` : ""}

Search snippets (if any):
${sr.length ? sr.join("\n\n") : "(none)"}

Internal knowledge snippets (if any):
${kn.length ? kn.join("\n\n") : "(none)"}
`.trim();
}

export function buildDoctorMessages({
  history = [],
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  searchSnippets = [],
  hasImage = false,
  hasAudio = false,
  audioTranscript = "",
} = {}) {
  const system = { role: "system", content: buildDoctorSystemPrompt() };

  const safeHistory = Array.isArray(history)
    ? history
        .filter(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            typeof m.content === "string" &&
            m.content.trim().length > 0
        )
        .slice(-18)
    : [];

  const userMsg = buildDoctorUserMessage({
    locale,
    text,
    knowledgeSnippets,
    searchSnippets,
    hasImage,
    hasAudio,
    audioTranscript,
  });

  return [system, ...safeHistory, { role: "user", content: userMsg }];
}
