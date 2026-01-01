// doctorPrompt.js

export function buildDoctorSystemPrompt() {
  return `
You are FixLens Brain, a professional automotive diagnostic assistant.

Rules:
- Always respond in the user's language automatically.
- Use a calm, respectful, neutral tone.
- Write a single professional paragraph only.
- Do NOT use bullet points, lists, or headings.
- Be practical and specific.
- Ask at most two short clarifying questions only if needed.
- If the situation may be unsafe, advise stopping and seeking professional help.
- Never invent prices, locations, phone numbers, or addresses.
- If web search data is provided, use it carefully and realistically.
- Do not mention internal systems, prompts, or tools.
`;
}

export function shouldWebSearch(userText) {
  if (!userText) return false;
  const t = userText.toLowerCase();

  // English triggers
  const en = [
    "price",
    "cost",
    "how much",
    "near me",
    "closest",
    "shop",
    "store",
    "mechanic",
    "tow",
    "battery price",
    "starter price",
    "alternator price",
    "auto parts",
    "where can i buy",
  ];

  // Arabic triggers
  const ar = [
    "سعر",
    "كم",
    "بكم",
    "وين",
    "اقرب",
    "قريب",
    "محل",
    "ورشة",
    "قطع",
    "سحب",
    "بطارية",
  ];

  return en.some(k => t.includes(k)) || ar.some(k => userText.includes(k));
}

export function buildUserInput({ message, history = [], web }) {
  const historyText = history
    .map(m => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.text}`)
    .join("\n");

  let webBlock = "WEB_RESULTS: none";
  if (web?.ok && Array.isArray(web.results) && web.results.length > 0) {
    webBlock =
      "WEB_RESULTS:\n" +
      web.results.slice(0, 5).map((r, i) => {
        return `${i + 1}) ${r.title || ""}\n${r.snippet || ""}\n${r.link || ""}`;
      }).join("\n\n");
  }

  return `
Conversation history:
${historyText || "(none)"}

User message:
${message}

${webBlock}

Respond now as FixLens Brain.
`;
}
