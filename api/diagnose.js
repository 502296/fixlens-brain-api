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

// ---------- Greeting detector ----------
function isGreetingLike(textLower) {
const greetings = [
'hello',
'hi',
'hey',
'hola',
'bonjour',
'ciao',
'hallo',
'ola',
'مرحبا',
'مرحبه',
'هلو',
'سلام',
'السلام عليكم',
'مرحباً',
];

const trimmed = textLower.trim();

// إذا الرسالة قصيرة (تحية + كلمتين مثلاً)
if (trimmed.length <= 40) {
for (const g of greetings) {
if (trimmed === g || trimmed.startsWith(g + ' ') || trimmed.includes(' ' + g + ' ')) {
return true;
}
}
}

return false;
}

// ---------- API Handler ----------
export default async function handler(req, res) {
if (req.method !== 'POST') {
return res.status(405).json({ error: 'Only POST allowed' });
}

try {
let { issue, hasImage, hasAudio } = req.body || {};
issue = (issue || '').toString().trim();

if (!issue) {
return res
.status(400)
.json({ error: 'Missing "issue" field in request body.' });
}

const textLower = issue.toLowerCase();

// 0) إذا كانت فقط "سلام / Hello / Hi ..." → رد لطيف قصير مثل ChatGPT
if (isGreetingLike(textLower)) {
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens, a friendly AI assistant for real-world car diagnostics.
When the user is just greeting you or making small talk (no clear car problem),
you MUST:

- Detect the user's language from their message.
- Reply in the SAME language.
- Keep the reply SHORT (1–3 sentences).
- Say hello back in a warm, human way.
- Invite them to describe their car problem: noises, vibrations, warning lights, smells, performance issues, etc.
- DO NOT use numbered sections or "Summary / Possible Causes" format here.
`.trim(),
},
{ role: 'user', content: issue },
],
});

const reply =
completion.choices[0]?.message?.content ||
'Hello! Tell me what your car is doing, and I’ll help you diagnose it step by step.';

return res.status(200).json({
reply,
matchesFound: 0,
mode: 'greeting',
});
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
`,
)
.join('\n\n');
}

// 2) Construct the prompt for GPT-4o
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

// 3) Call GPT-4o
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain V2, a world-class technician AI for real cars.

- ALWAYS answer in the SAME language the user used in their message (detect automatically).
- If you must mention technical part names, you can keep those in English, but explain everything else in the user's language.
- Keep the explanation clear, friendly, and practical for normal drivers (not engineers).
- Use the numbered structure requested by the developer.

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
mode: 'diagnosis',
});
} catch (err) {
console.error('FixLens ERROR:', err);
return res.status(500).json({
error: 'FixLens Brain internal error.',
details: err.message,
});
}
}
