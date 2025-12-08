// lib/autoKnowledge.js
// Load and match common auto issues from JSON

import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
if (cachedIssues) return cachedIssues;

try {
const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");
const raw = fs.readFileSync(filePath, "utf8");
cachedIssues = JSON.parse(raw);
} catch (err) {
console.error(
"[FixLens] Failed to load auto_common_issues.json – continuing without KB:",
err
);
// 👉 لا نوقف الـ API، بس نكمل بدون قاعدة معرفة
cachedIssues = [];
}

return cachedIssues;
}

/**
* Very simple keyword-based matching to find relevant issues.
* description: user problem description (text or transcription)
*/
export function findRelevantIssues(description, maxMatches = 5) {
if (!description) return [];
const issues = loadIssues();
if (!issues || issues.length === 0) return [];

const text = description.toLowerCase();
const scored = issues.map((issue) => {
const keywords = (issue.keywords || []).map((k) =>
String(k).toLowerCase()
);
let score = 0;
for (const k of keywords) {
if (text.includes(k)) score += 1;
}
return { issue, score };
});

scored.sort((a, b) => b.score - a.score);
return scored
.filter((s) => s.score > 0)
.slice(0, maxMatches)
.map((s) => s.issue);
}
