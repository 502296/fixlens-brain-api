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
// each file is an array
allData = allData.concat(json);
} catch (e) {
console.error(`Error parsing ${file}:`, e);
}
}
}

return allData;
}

const KNOWLEDGE_BASE = loadKnowledge();

// ---------- Simple matching engine ----------
function findMatches(issueText) {
if (!issueText || issueText.length < 2) return [];

const text = issueText.toLowerCase();
const matches = [];

for (const item of KNOWLEDGE_BASE) {
const titleMatch = item.title?.toLowerCase().includes(text) ? 3 : 0;
const symptomMatch = item.symptoms?.some((s) =>
s.toLowerCase().includes(text)
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

// ---------- Helper: detect if the user just said "hello" ----------
function looksLikeGreeting(issue) {
const text = issue.trim().toLowerCase();

const greetings = [
'hi',
'hello',
'hey',
'السلام عليكم',
'هلا',
'هلو',
'مرحبا',
'bonjour',
'hola',
'ciao',
'hallo',
'ola',
];

return greetings.some((g) => text === g || text.startsWith(g + ' '));
}

// ---------- API Handler ----------
export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ error: 'Only POST allowed' });
}

try {
let { issue, hasImage, hasAudio, languageCode, type } = req.body || {};

if (!issue || typeof issue !== 'string') {
return res
.status(400)
.json({ error: 'Missing "issue" field in request body.' });
}

// 1) Retrieve top matches from knowledge
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
`
)
.join('\n\n');
}

const isGreetingOnly = looksLikeGreeting(issue);

// 2) Construct the prompt for GPT-4o
const prompt = `
User message:
"${issue}"

Image Provided: ${hasImage ? 'YES' : 'NO'}
Audio Provided: ${hasAudio ? 'YES' : 'NO'}
Mode: ${type || 'text'}

Below is internal FixLens expert knowledge (V2):

${contextText}

Rules:

1) First, DETECT the user's language from their message and always answer in that language.
2) If the user is only greeting or doing small talk (like "hello", "هلو", "bonjour", "hola", etc.),
- Do NOT do a full technical diagnosis.
- Just answer with a short, friendly greeting and then ask them to describe their car problem
(no numbered sections, no big report).
3) If the user clearly describes a vehicle problem (noises, vibrations, warning lights, leaks, etc.),
- Then use this structure in your answer:

1) Summary
2) Possible Causes
3) What To Check First
4) Step-by-Step Fix
5) Safety Warnings (if needed)

4) Keep your explanation clear and friendly for a normal driver (not an engineer).
5) Focus only on cars / vehicles / mechanical or electrical issues related to driving.
`.trim();

const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain V2, an expert AI technician for vehicles.

- Always detect the user's language from their message and respond ONLY in that language.
- If the message is just a greeting or small talk, reply briefly and warmly, then ask them
to describe the problem with their car – no diagnosis report in that case.
- If the user actually describes a vehicle issue, follow the required structure carefully.
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
languageCode: languageCode || 'auto',
isGreetingOnly,
});
} catch (err) {
console.error('FixLens ERROR:', err);
return res.status(500).json({
error: 'FixLens Brain internal error.',
details: err.message,
});
}
}
