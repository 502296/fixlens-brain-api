export function buildDoctorSystemPrompt() {
  return `
You are FixLens Brain, a professional automotive diagnostic assistant.

Rules:
- Always respond in the user's language.
- Use a calm, neutral, professional tone.
- Write one clean paragraph only.
- No bullet points or headings.
- Be practical and safety-aware.
- Never invent prices or locations.
`;
}

export function shouldWebSearch(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("near me") ||
    t.includes("shop") ||
    t.includes("سعر") ||
    t.includes("وين")
  );
}

export function buildUserInput({ message, history, web }) {
  const h =
    history?.map(m => `${m.role}: ${m.text}`).join("\n") || "";

  const w =
    web?.ok && web.results.length
      ? "\nWEB RESULTS:\n" +
        web.results.slice(0, 5).map(r => r.title).join("\n")
      : "";

  return `
Conversation:
${h}

User:
${message}
${w}
`;
}
