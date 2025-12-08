// lib/fixlensBrain.js
// Central brain for FixLens (text / audio / image all go here)

import OpenAI from "openai";
import { findRelevantIssues } from "./autoKnowledge.js";

export const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

/**
* mode: "text" | "audio" | "image"
* text: user problem description (raw text or transcription)
* audioTranscription: same as text but kept for clarity (optional)
* imageBase64: optional base64 image (without data: prefix)
*/
export async function runFixLensBrain({
mode,
text,
audioTranscription,
imageBase64,
}) {
const userText = text || audioTranscription || "";

// Match common issues from JSON
const relevant = userText ? findRelevantIssues(userText, 5) : [];
const issuesContext =
relevant.length > 0
? relevant
.map(
(it, idx) =>
`${idx + 1}. ${it.title}\nSymptoms: ${it.symptoms || ""}\nNotes: ${
it.notes || ""
}`
)
.join("\n\n")
: "None with high confidence.";

const systemPrompt = `
You are **FixLens Auto**, a friendly, expert automotive diagnosis assistant.

Goals:
- Help users understand possible causes of their car problems.
- Always be clear, calm, and safety-focused.
- Assume the user might not be a mechanic. Use simple language when possible.

Language:
- ALWAYS reply in the same language as the user's last message.
- Detect the language automatically from the text or description.
- If the user mixes languages, prefer the language they use most recently.

Constraints:
- You are not physically inspecting the car.
- Never give absolute guarantees.
- Always include safety warnings when issues might be dangerous (brakes, steering, fuel, overheating, electrical burning smell, etc.).
- Encourage users to see a qualified mechanic when necessary.

Context:
- The user is using a mobile app called FixLens.
- Mode: ${mode}.
- Matched common issues from knowledge base (may or may not be correct):
${issuesContext}

Response format:
1. Brief summary of what might be going on.
2. 2–4 possible causes, with short explanations.
3. Simple actions the user can try (if safe).
4. Clear safety note when needed.
`.trim();

const messages = [
{
role: "system",
content: systemPrompt,
},
];

if (mode === "image" && imageBase64) {
// Vision: image + optional text
const promptText =
userText && userText.trim().length > 0
? userText
: "Analyze this car-related image and explain what might be going on. Then give actionable advice and safety notes.";

messages.push({
role: "user",
content: [
{ type: "text", text: promptText },
{
type: "image_url",
image_url: {
url: `data:image/jpeg;base64,${imageBase64}`,
detail: "auto",
},
},
],
});
} else {
// Text or audio (transcribed as text)
messages.push({
role: "user",
content:
userText ||
"The user did not provide any description. Ask them kindly to describe the problem with their car.",
});
}

const completion = await openai.chat.completions.create({
model: "gpt-4o",
messages,
temperature: 0.4,
});

const reply =
completion.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a response. Please try again.";

return {
reply,
language: "auto", // language is auto-detected in the model; we keep a simple flag here
mode,
domain: "auto",
summary: null,
checks: [],
warnings: [],
};
}
