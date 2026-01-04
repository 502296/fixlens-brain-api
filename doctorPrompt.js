// doctorPrompt.js
// FixLens Doctor Mechanic Pro — unified brain for text/image/audio.
// English-only code, but MUST reply in the user's language.

function safeText(x) {
  return String(x || "").trim();
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
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
  const lang = normalizeLocale(locale);
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
(An image is attached. Use it carefully and only state what you can actually see.)` : ""}

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
  // ✅ Accept history entries shaped as:
  //  - { role, content } OR { role, text }
  const safeHistory = Array.isArray(history)
    ? history
        .map((m) => {
          const role = m?.role === "assistant" ? "assistant" : "user";
          const c = typeof m?.content === "string" ? m.content : (typeof m?.text === "string" ? m.text : "");
          const content = safeText(c);
          return content ? { role, content } : null;
        })
        .filter(Boolean)
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

  return [...safeHistory, { role: "user", content: userMsg }];
}
