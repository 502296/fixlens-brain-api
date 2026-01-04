// service.js
// FixLens Doctor Mechanic Pro (Search-enabled, unified, multi-modal)
// English-only codebase. Replies in the user's language.

import { buildKnowledgeSnippets } from "./lib/autoKnowledge.js";
import { buildDoctorMessages } from "./doctorPrompt.js";
import { webSearchSerper } from "./lib/search.js";
import OpenAI from "openai";

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "";
const openai = new OpenAI({ apiKey: OPENAI_KEY });

const MODEL_TEXT = process.env.MODEL_TEXT || "gpt-4o-mini";
const MODEL_VISION = process.env.MODEL_VISION || MODEL_TEXT;

const MAX_KNOWLEDGE_SNIPS = Number(process.env.MAX_KNOWLEDGE_SNIPS || 7);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS || 5);
const MAX_SEARCH_SNIPS = Number(process.env.MAX_SEARCH_SNIPS || 3);

function safeText(s) {
return String(s || "").trim();
}

function normalizeLocale(locale = "en") {
const l = String(locale || "en").trim();
if (!l) return "en";
return l.split("-")[0].toLowerCase();
}

function clampArray(arr, max) {
if (!Array.isArray(arr)) return [];
return arr.slice(0, Math.max(0, max));
}

function hasSerperKey() {
return Boolean(process.env.SERPER_API_KEY);
}

// ------------------------
// Search intent detection (language-agnostic)
// ------------------------
// No non-English strings in code. We detect intent via:
// - classic English commerce/location keywords OR
// - presence of Latin location tokens + question marks (works for mixed Arabic + "Louisville Kentucky")
function isSearchIntent(text = "", locale = "en") {
const raw = String(text || "").trim();
if (!raw) return false;
const t = raw.toLowerCase();

const hasEnglishPlace =
t.includes("near me") ||
t.includes("nearby") ||
t.includes("closest") ||
t.includes("where is") ||
t.includes("location") ||
t.includes("address") ||
t.includes("directions") ||
t.includes("google maps") ||
t.includes("maps") ||
t.includes("mechanic") ||
t.includes("garage") ||
t.includes("repair shop") ||
t.includes("workshop");

const hasEnglishCommerce =
t.includes("price") ||
t.includes("cost") ||
t.includes("how much") ||
t.includes("part number") ||
t.includes("oem") ||
t.includes("aftermarket") ||
t.includes("recall") ||
t.includes("tsb") ||
t.includes("service bulletin") ||
t.includes("where can i buy") ||
t.includes("where to buy") ||
t.includes("where can i find") ||
t.includes("where to find") ||
t.includes("shop") ||
t.includes("store") ||
t.includes("order online");

if (hasEnglishPlace || hasEnglishCommerce) return true;

// Mixed-language heuristic:
// If locale isn't English and user includes Latin location tokens (e.g. "Louisville Kentucky")
// and asks a question ("?" or "؟"), we allow web search.
const isNonEnglish = normalizeLocale(locale) !== "en";
const hasLatinTokens = /[A-Za-z]{3,}/.test(raw);
const hasQuestionMark = /[?¿؟]/.test(raw);
const hasTwoLatinWords = (raw.match(/[A-Za-z]{3,}/g) || []).length >= 2;

return Boolean(isNonEnglish && hasLatinTokens && hasTwoLatinWords && hasQuestionMark);
}

function formatSearchSnippets(results = []) {
return (results || [])
.slice(0, MAX_SEARCH_SNIPS)
.map((r) => {
const title = safeText(r?.title);
const link = safeText(r?.link);
const snippet = safeText(r?.snippet);

const chunks = [];
if (title) chunks.push(title);
if (snippet) chunks.push(snippet);
if (link) chunks.push(`Source: ${link}`);
return chunks.filter(Boolean).join("\n");
})
.filter(Boolean);
}

async function maybeWebSearch(userText, locale, { gl = "us", hl = "en", num = MAX_SEARCH_RESULTS } = {}) {
if (!isSearchIntent(userText, locale)) return { ok: true, snippets: [], used: false };
if (!hasSerperKey()) return { ok: false, snippets: [], used: false, error: "NO_SERPER_API_KEY" };

const q = safeText(userText);
if (!q) return { ok: true, snippets: [], used: false };

const res = await webSearchSerper(q, { gl, hl, num });
if (!res?.ok) return { ok: false, snippets: [], used: true, error: res?.error || "SEARCH_FAILED" };

const snippets = formatSearchSnippets(res?.results || []);
return { ok: true, snippets, used: true };
}

// ------------------------
// Audio transcription (real)
// ------------------------
async function transcribeAudio({ audioBuffer, audioMime = "audio/m4a" }) {
if (!OPENAI_KEY) throw new Error("NO_OPENAI_KEY");
if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) return "";

// Node 18+ supports fetch/FormData/Blob
const form = new FormData();
form.append("model", "whisper-1");

const blob = new Blob([audioBuffer], { type: audioMime });
form.append("file", blob, "audio.m4a");

const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
method: "POST",
headers: { Authorization: `Bearer ${OPENAI_KEY}` },
body: form,
});

const data = await r.json();
if (!r.ok) {
const msg = data?.error?.message || JSON.stringify(data);
throw new Error(`TRANSCRIPTION_FAILED: ${msg}`);
}
return safeText(data?.text);
}

// ------------------------
// Main doctor runner
// ------------------------
async function runDoctor({
locale = "en",
text = "",
history = [],
hasImage = false,
imageBuffer = null,
imageMime = "image/jpeg",
hasAudio = false,
audioBuffer = null,
audioMime = "audio/m4a",
audioTranscript = "",
} = {}) {
if (!OPENAI_KEY) {
return { ok: false, error: "NO_OPENAI_KEY", reply: "" };
}

const lang = normalizeLocale(locale);
const userTextRaw = safeText(text);

// 1) Internal knowledge
let knowledgeSnippets = [];
try {
knowledgeSnippets = await buildKnowledgeSnippets(userTextRaw, { locale: lang });
} catch {
knowledgeSnippets = [];
}
const knowledgeClamped = clampArray(knowledgeSnippets || [], MAX_KNOWLEDGE_SNIPS);

// 2) Web search
const search = await maybeWebSearch(userTextRaw, lang, { gl: "us", hl: "en", num: MAX_SEARCH_RESULTS });
const searchSnips = clampArray(search?.snippets || [], MAX_SEARCH_SNIPS);

// 3) Transcribe audio if needed
let transcript = safeText(audioTranscript);
if (hasAudio && !transcript && audioBuffer) {
try {
transcript = await transcribeAudio({ audioBuffer, audioMime });
} catch {
transcript = "";
}
}

// 3.5) If audio attached but transcription failed, add a small helper note
// (English-only code, model will still reply in user's locale via system prompt)
let userText = userTextRaw;
if (hasAudio && !transcript) {
userText =
`${userTextRaw}\n\n` +
`Audio is attached. If transcription is unclear, still give best next steps, safety guidance, and ask ONE follow-up question.`;
}

// 4) Build unified messages with history
const messages = buildDoctorMessages({
history,
locale: lang,
text: userText,
knowledgeSnippets: knowledgeClamped,
searchSnippets: searchSnips,
hasImage: Boolean(hasImage),
hasAudio: Boolean(hasAudio),
audioTranscript: transcript,
});

// 5) Call OpenAI (Vision if image exists)
try {
const modelToUse = hasImage && imageBuffer ? MODEL_VISION : MODEL_TEXT;

let completion;
if (hasImage && imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
const b64 = imageBuffer.toString("base64");
const mime = imageMime || "image/jpeg";

completion = await openai.chat.completions.create({
model: modelToUse,
temperature: 0.4,
max_tokens: 700,
messages: [
messages[0],
...messages.slice(1, -1),
{
role: "user",
content: [
{ type: "text", text: messages[messages.length - 1].content },
{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
],
},
],
});
} else {
completion = await openai.chat.completions.create({
model: modelToUse,
temperature: 0.4,
max_tokens: 700,
messages,
});
}

const reply = safeText(completion?.choices?.[0]?.message?.content);

return {
ok: true,
reply: reply || "",
meta: {
locale: lang,
used_search: Boolean(search?.used),
search_ok: Boolean(search?.ok),
search_error: search?.error || "",
search_snips: searchSnips.length,
knowledge_snips: knowledgeClamped.length,
hasImage: Boolean(hasImage),
hasAudio: Boolean(hasAudio),
hasTranscript: Boolean(transcript),
model: modelToUse,
},
transcript,
};
} catch {
return { ok: false, error: "OPENAI_CALL_FAILED", reply: "" };
}
}

// ------------------------
// Public API for server.js
// ------------------------
export async function handleFixLensRequest(input = {}) {
const locale = normalizeLocale(input?.locale || "en");
const text = safeText(input?.text || input?.message || "");
const history = Array.isArray(input?.history) ? input.history : [];

const imageBuffer = input?.imageBuffer || null;
const imageMime = safeText(input?.imageMime || input?.imageType || "image/jpeg");
const hasImage = Boolean(input?.hasImage || (imageBuffer && Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0));

const audioBuffer = input?.audioBuffer || null;
const audioMime = safeText(input?.audioMime || input?.audioType || "audio/m4a");
const audioTranscript = safeText(input?.audioTranscript || "");
const hasAudio = Boolean(input?.hasAudio || (audioBuffer && Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0));

const out = await runDoctor({
locale,
text,
history,
hasImage,
imageBuffer,
imageMime,
hasAudio,
audioBuffer,
audioMime,
audioTranscript,
});

if (!out?.ok) {
return { ok: false, error: out?.error || "UNKNOWN_ERROR", reply: "" };
}

return {
ok: true,
reply: out.reply,
transcript: out.transcript || "",
meta: out.meta || {},
};
}
