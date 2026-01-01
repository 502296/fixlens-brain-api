// lib/doctorPrompt.js

export function buildDoctorPrompt({
  mode = "text",
  userText = "",
  history = [],
  locale = "auto",
  web = null,
}) {
  const historyBlock = Array.isArray(history) && history.length
    ? history
        .slice(-8)
        .map((m) => {
          const role = m?.role === "assistant" ? "Assistant" : "User";
          const content = (m?.content ?? "").toString().slice(0, 800);
          return `${role}: ${content}`;
        })
        .join("\n")
    : "";

  const webBlock = Array.isArray(web) && web.length
    ? web
        .slice(0, 5)
        .map((r, i) => {
          const title = (r?.title ?? "").toString();
          const link = (r?.link ?? "").toString();
          const snippet = (r?.snippet ?? "").toString();
          return `[${i + 1}] ${title}\n${link}\n${snippet}`;
        })
        .join("\n\n")
    : "";

  // IMPORTANT:
  // - One professional mechanic-style report.
  // - No headings, no bullet points.
  // - Always reply in the user's language.
  // - Simple, neutral tone (white language).
  // - Ask only minimal follow-ups at the end.

  return `
You are FixLens Doctor Mechanic, a professional automotive diagnostician.

Core rules:
- Reply in the same language as the user's message (auto-detect). Never switch languages.
- Use a calm, neutral, clear tone. Avoid slang. Avoid academic tone.
- Output must be ONE continuous professional report with no headings and no bullet points.
- Keep it practical: likely causes, quick checks, safety notes, and what to ask a shop to inspect.
- Do not claim certainty. Use probabilities and conditional reasoning.
- If the user did not provide the car year/make/model, ask for it only once at the end.
- If the issue could be unsafe, advise to stop driving and inspect.

Mode: ${mode}
Locale hint: ${locale}

Conversation context (if any):
${historyBlock || "(none)"}

Web context (if any):
${webBlock || "(none)"}

User request:
${userText}

Now produce the report.
`.trim();
}
