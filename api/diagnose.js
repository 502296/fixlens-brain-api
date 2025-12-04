// api/diagnose.js

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Load Knowledge Base (all JSON files) ----------
function loadKnowledge() {
const knowledgeDir = path.join(process.cwd(), 'brain', 'knowledge');
const files = fs.readdirSync(knowledgeDir);

let allData = [];

for (const file of files) {
if (file.endsWith('.json')) {
const filePath = path.join(knowledgeDir, file);
const raw = fs.readFileSync(filePath, 'utf8');
try {
const json = JSON.parse(raw);
allData = allData.concat(json);
} catch (e) {
console.error(`Error parsing ${file}:`, e);
}
}
}

return allData;
}

const KNOWLEDGE_BASE = loadKnowledge();

// ---------- Language Names ----------
const LANGUAGE_NAMES = {
en: 'English',
ar: 'Arabic',
es: 'Spanish',
fr: 'French',
de: 'German',
it: 'Italian',
pt: 'Portuguese',
hi: 'Hindi',
zh: 'Chinese (Simplified)',
ja: 'Japanese',
};

// ---------- Simple matching engine ----------
function findMatches(issueText) {
if (!issueText || issueText.length < 2) return [];

const text = issueText.toLowerCase();
const matches = [];

for (const item of KNOWLEDGE_BASE) {
const titleMatch = item.title?.toLowerCase().includes(text) ? 3 : 0;
const symptomMatch = item.symptoms?.some((s) =>
s.toLowerCase().includes(text),
)
? 2
: 0;

const score = titleMatch + symptomMatch;

if (score > 0) {
matches.push({
...item,
score,
});
}
}

return matches.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---------- API Handler ----------
export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ error: 'Only POST allowed' });
}

try {
let { issue, hasImage, hasAudio, languageCode } = req.body || {};

if (!issue || typeof issue !== 'string') {
return res
.status(400)
.json({ error: 'Missing "issue" field in request body.' });
}

// default language fallback
if (!languageCode) languageCode = 'en';
const languageName =
LANGUAGE_NAMES[languageCode] || "the user's preferred language";

const lowerIssue = issue.trim().toLowerCase();

// ---------- 0) Small talk / greetings ----------
const smallTalkPatterns = [
'hi',
'hello',
'hey',
'good morning',
'good evening',
'how are you',
'thank you',
'thanks',
'سلام',
'مرحبا',
];

const isSmallTalk = smallTalkPatterns.some((p) =>
lowerIssue.startsWith(p),
);

if (isSmallTalk) {
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain, a friendly automotive assistant.

If the user is just greeting you or making casual conversation:
- Answer in ${languageName}.
- Be warm and human-like (2–3 short sentences).
- Do NOT give a full diagnostic structure.
- You can gently invite them to describe their car issue if they have one.
`.trim(),
},
{ role: 'user', content: issue },
],
});

const reply =
completion.choices[0]?.message?.content ||
'Hello! I am FixLens Brain. How can I help you with your vehicle today?';

return res.status(200).json({
reply,
matchesFound: 0,
languageCode,
});
}

// ---------- 1) Retrieve top matches from knowledge ----------
const matches = findMatches(issue);

let contextText = 'No matches found in FixLens Knowledge Base.';
if (matches.length > 0) {
contextText = matches
.map(
(m) => `
### Possible Match: ${m.title}
Symptoms: ${m.symptoms?.join(', ') || 'N/A'}
Possible Causes: ${m.possible_causes?.join(', ') || 'N/A'}
Recommended Actions: ${m.recommended_actions?.join(', ') || 'N/A'}
Severity: ${m.severity || 'unknown'}
`,
)
.join('\n\n');
}

// ---------- 2) Construct the prompt for GPT-4o ----------
const prompt = `
User issue:
"${issue}"

Image Provided: ${hasImage ? 'YES' : 'NO'}
Audio Provided: ${hasAudio ? 'YES' : 'NO'}

Below is internal FixLens expert knowledge (V2):

${contextText}

Using the knowledge + your own reasoning,
provide a clear, simple, step-by-step diagnosis.

Follow this exact structure:

1) Summary
2) Possible Causes
3) What To Check First
4) Step-by-Step Fix
5) Safety Warnings (if needed)
`.trim();

// ---------- 3) Call GPT-4o ----------
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain V2, a world-class technician AI.

Always answer ONLY in ${languageName}.
Do NOT switch to English unless you must quote a technical term.
Keep the explanation clear and friendly for a normal user (not an engineer).
`.trim(),
},
{ role: 'user', content: prompt },
],
});

const reply =
completion.choices[0]?.message?.content || 'Diagnostic error.';

return res.status(200).json({
reply,
matchesFound: matches.length,
languageCode,
});
} catch (err) {
console.error('FixLens ERROR:', err);
return res.status(500).json({
error: 'FixLens Brain internal error.',
details: err.message,
});
}
}
