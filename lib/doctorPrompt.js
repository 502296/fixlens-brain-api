// doctorPrompt.js

export function buildDoctorSystemPrompt() {
  return [
    "You are FixLens Brain, a professional automotive diagnostic assistant.",
    "Write in a calm, respectful, neutral style.",
    "Always answer in the user's language based on their message.",
    "Do not use headings or bullet points. Output a single, clean professional paragraph.",
    "Be practical and specific. Ask at most 2 short clarifying questions only when needed.",
    "Safety: If a step may be risky, suggest a safe alternative or professional inspection.",
    "Liability: Encourage the user to stop if they are unsure and consult a qualified mechanic.",
    "If web search results are provided, use them to answer pricing/locations realistically and mention sources briefly.",
    "Never invent addresses, phone numbers, prices, or store details without sources.",
  ].join("\n");
}

export function shouldWebSearch(userText) {
  const t = (userText || "").toLowerCase();

  // English triggers
  const en = [
    "price",
    "cost",
    "how much",
    "near me",
    "closest",
    "address",
    "phone",
    "open now",
    "hours",
    "shop",
    "store",
    "mechanic near",
    "tow",
    "battery price",
    "starter price",
    "alternator price",
    "auto parts",
  ];

  // Arabic triggers (logic only; still fine to keep project English text overall)
  const ar = [
    "سعر",
    "كم",
    "بكم",
    "وين",
    "اقرب",
    "قريب مني",
    "محل",
    "ورشة",
    "قطع غيار",
    "عنوان",
    "رقم",
    "يفتح",
    "دوام",
  ];

  return en.some((k) => t.includes(k)) || ar.some((k) => (userText || "").includes(k));
}

export function buildUserInput({ message, history = [], web }) {
  const h = (history || [])
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      return `${role}: ${m.text}`;
    })
    .join("\n");

  const webBlock =
    web?.ok && Array.isArray(web.results) && web.results.length
      ? [
          "WEB_RESULTS (use only if needed for prices/locations; do not fabricate):",
          ...web.results.slice(0, 5).map((r, i) => {
            const title = r.title || "";
            const link = r.link || "";
            const snippet = r.snippet || "";
            return `${i + 1}) ${title}\n${snippet}\n${link}`;
          }),
        ].join("\n\n")
      : "WEB_RESULTS: none";

  return [
    "Conversation context:",
    h ? h : "(no prior messages)",
    "",
    "User message:",
    message,
    "",
    webBlock,
    "",
    "Now respond as FixLens Brain.",
  ].join("\n");
}
