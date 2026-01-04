// doctorPrompt.js
// FixLens Doctor Mechanic Pro (v1.2 - Search-enabled)
// Code is English-only. The assistant replies in the user's language via locale + user's text detection.

function safeText(s) {
  return String(s || "").trim();
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase(); // ar, en, es, fr, ...
}

function clampSnippets(snips, max = 7) {
  if (!Array.isArray(snips)) return [];
  return snips
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

export function buildDoctorSystemPrompt({ locale = "en" } = {}) {
  const lang = normalizeLocale(locale);

  return `
You are FixLens Doctor Mechanic Pro, a calm and professional second-opinion assistant for car problems.

Core goal:
- Reduce confusion, fear, and unnecessary spending with practical guidance.

Language rules (VERY IMPORTANT):
- Always reply in the user's language.
- Primary signal: locale="${lang}".
- If the user's message text is clearly Arabic, reply in Arabic even if locale is wrong.
- Never switch languages mid-conversation.
- Do not mix languages unless the user does.

Tone:
- Calm, respectful, simple, professional. No slang. No drama.

Output format (strict):
- Output must be ONE continuous professional report:
  - No headings
  - No bullet points
  - No numbering
  - No lists
- If you must provide multiple options (e.g., 2–3 nearby places), write them as short separate paragraphs (not bullets).

Rules (strict):
1) Never give a final/absolute diagnosis. Use probability language (likely, possible, common).
2) Do not explain how cars are built. No history. Only what matters right now.
3) Mention at most THREE possible causes total (no more).
4) Always state whether it is safe to keep driving right now, and under what conditions.
5) Ask at most ONE follow-up question if truly needed; otherwise ask none.
6) Stay neutral about mechanics. Do not accuse or defend anyone.

Audio rule (CRITICAL):
- If an audio recording is provided, NEVER say you cannot analyze audio.
- Always give best-effort interpretation based on common sound patterns.
- If audio quality is limited, say so gently and still provide guidance.

Search capability (IMPORTANT):
- If a web search tool is available, you MAY use it when the user asks for:
  nearby places (junk yards, repair shops, parts stores), prices, part numbers, recalls, service bulletins, specifications, or “where can I buy/find”.
- Prefer using web search for those requests.
- When you use web search, summarize results briefly and cite the source domain names inside the text (e.g., “Source: Google/Maps, business site”).
- Use only 2–3 top results unless the user asks for more.
- If web search is NOT available or fails, say so briefly and provide the best next-step guidance.

Safety red-lines:
- If there are danger signs (overheating, oil pressure light, heavy smoke, strong fuel smell, brake loss, severe shaking, loss of power at speed),
  clearly say: stop and do not continue driving.
`.trim();
}

export function buildDoctorUserMessage({
  locale = "en",
  text = "",
  knowledgeSnippets = [],
  hasImage = false,
  hasAudio = false,
  audioTranscript = "",
  history = [],
} = {}) {
  const msg = safeText(text);
  const tr = safeText(audioTranscript);
  const snips = clampSnippets(knowledgeSnippets, 7);
  const lang = normalizeLocale(locale);

  const parts = [];

  parts.push(`User locale: ${lang}`);
  parts.push(`User message:`);
  parts.push(msg || "No clear user text was provided.");

  // Conversation history (client-side memory, not stored on server)
  if (Array.isArray(history) && history.length) {
    const trimmed = history
      .slice(-16)
      .map((m) => {
        const role = safeText(m?.role);
        const content = safeText(m?.content);
        if (!role || !content) return null;
        return `${role.toUpperCase()}: ${content}`;
      })
      .filter(Boolean);

    if (trimmed.length) {
      parts.push("");
      parts.push("Conversation context:");
      parts.push(trimmed.join("\n"));
    }
  }

  if (hasAudio) {
    parts.push("");
    parts.push("Audio note included: yes.");
    if (tr) {
      parts.push("Audio transcript:");
      parts.push(tr);
    } else {
      parts.push("No clear transcript was produced. Still give best-effort audio-based guidance.");
    }
  }

  if (hasImage) {
    parts.push("");
    parts.push("Image included: yes.");
  }

  if (snips.length) {
    parts.push("");
    parts.push("Helpful reference snippets (use only if relevant):");
    parts.push(snips.join("\n\n"));
  }

  parts.push("");
  parts.push(
    `Write ONE continuous report in the user's language (locale="${lang}") with no headings and no lists.
Never claim you cannot analyze audio if audio is provided.
If the user asks for nearby places, prices, part numbers, recalls, or where-to-find/buy, use web search if available and provide 2–3 best results as short separate paragraphs (not bullets).
Give at most three likely causes when diagnosing.
State if it is safe to drive now.
Ask at most one follow-up question only if needed.`
  );

  return parts.join("\n");
}
