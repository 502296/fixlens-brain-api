// api/diagnose.js

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Load Knowledge Base ----------
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
matches.push({ ...item, score });
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
let { issue, hasImage, hasAudio } = req.body || {};

if (!issue || typeof issue !== 'string') {
return res
.status(400)
.json({ error: 'Missing "issue" field in request body.' });
}

const trimmed = issue.trim();
const lowerIssue = trimmed.toLowerCase();

// ---------- 0) Greeting / Small talk detector ----------
const normalized = lowerIssue
.replace(/[!?.،,.]/g, '')
.replace(/\s+/g, ' ')
.trim();

const smallTalkPatterns = [
'hi',
'hello',
'hey',
'good morning',
'good evening',
'good night',
'how are you',
'thanks',
'thank you',
'سلام',
'هلو',
'هلوو',
'مرحبا',
'مرحبه',
'شلونك',
'شلونج',
'كيفك',
'كيف الحال',
'شكرا',
'ثانكس',
'hola',
'bonjour',
'ciao',
'hallo',
'ola',
];

const isShort = normalized.split(' ').length <= 6;
const isSmallTalk =
isShort &&
smallTalkPatterns.some(
(p) =>
normalized === p ||
normalized.startsWith(p) ||
normalized.includes(` ${p} `),
);

if (isSmallTalk) {
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain, a friendly multi-lingual automotive assistant.

- Detect the user's language automatically from their message.
- Reply in the SAME language as the user.
- This is casual small talk (greeting / thanks / how are you).
- Answer with 1–3 SHORT friendly sentences.
- Do NOT use any diagnostic structure like "Summary / Possible Causes".
- You may gently invite them to describe the vehicle issue if they have one.
`.trim(),
},
{ role: 'user', content: trimmed },
],
});

const reply =
completion.choices[0]?.message?.content ||
'Hello 👋 I am FixLens Brain. How can I help you with your vehicle today?';

return res.status(200).json({
reply,
matchesFound: 0,
});
}

// ---------- 1) Retrieve top matches from knowledge ----------
const matches = findMatches(trimmed);

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

// ---------- 2) Construct the prompt ----------
const prompt = `
User issue:
"${trimmed}"

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

// ---------- 3) Call GPT ----------
const completion = await client.chat.completions.create({
model: 'gpt-4o-mini',
messages: [
{
role: 'system',
content: `
You are FixLens Brain V2, a world-class automotive technician AI.

- Detect the user's language automatically.
- Always answer ONLY in that language.
- Keep the explanation friendly for a normal driver (not an engineer).
- Follow exactly the requested structure (1–5) with clear bullet points.
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
});
} catch (err) {
console.error('FixLens ERROR:', err);
return res.status(500).json({
error: 'FixLens Brain internal error.',
details: err.message,
});
}
}
