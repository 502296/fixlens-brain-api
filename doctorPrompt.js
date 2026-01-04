// doctorPrompt.js
// Unified Doctor Brain (Text + Image + Audio) — English-only prompt,
// but ALWAYS replies in the user's language.

export function buildDoctorSystemPrompt() {
  return `
You are FixLens, a calm and professional second-opinion assistant for car problems.

Goal:
- Reduce confusion, fear, and unnecessary spending.
- Give practical next steps, not big explanations.

Language:
- Always reply in the user's language.
- If the user's language is unclear or mixed, use languageHint if provided.

Rules:
1) Never give a final/absolute diagnosis.
2) Use probability language (likely/common/often).
3) Max 3 possible causes.
4) Always mention whether it is safe to continue driving.
5) Ask at most ONE follow-up question if needed.
6) No long lectures, no history, no manufacturing details.
7) Stay neutral: do not attack or defend mechanics.

Output style:
- No headings.
- No bullet points.
- One professional mechanic-style report in short paragraphs.
`.trim();
}

/**
 * Build the final messages array for the model.
 * We keep prompt in English, but instruct it to answer in user's language.
 */
export function buildDoctorMessages({
  history = [],
  userText = "",
  languageHint = "",
  imageNote = "",
  audioTranscript = "",
  knowledgeSnippets = "",
  hasImage = false,
  hasAudio = false,
} = {}) {
  const system = { role: "system", content: buildDoctorSystemPrompt() };

  // We let the client pass history (no server memory).
  // We sanitize roles and keep only user/assistant.
  const safeHistory = Array.isArray(history)
    ? history
        .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-14) // keep last N turns to avoid huge payloads
    : [];

  // Build a single unified user message that includes everything.
  // IMPORTANT: Always include languageHint & knowledge snippets here so text/image/audio behave the same.
  const unifiedUser = {
    role: "user",
    content: `
languageHint: ${languageHint || "unknown"}

User text:
${userText || "(none)"}

${hasImage ? `Image note:
${imageNote || "(image attached)"}` : ""}

${hasAudio ? `Audio transcript:
${audioTranscript || "(no transcript available)"}` : ""}

Internal knowledge (use only if relevant, never cite sources):
${knowledgeSnippets || "(none)"}
`.trim(),
  };

  return [system, ...safeHistory, unifiedUser];
}
