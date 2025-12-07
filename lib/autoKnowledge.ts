// lib/autoKnowledge.js
// Helper to load and match common auto issues from JSON

import fs from "fs";
import path from "path";

let cachedIssues = null;

/**
* Load the JSON file auto_common_issues.json from project root.
*/
function loadIssues() {
if (cachedIssues) return cachedIssues;

// 👈 هنا من الجذر مباشرة، بدون مجلد data
const filePath = path.join(process.cwd(), "auto_common_issues.json");
const raw = fs.readFileSync(filePath, "utf-8");
const data = JSON.parse(raw);

if (!Array.isArray(data)) {
throw new Error("auto_common_issues.json must be an array");
}

cachedIssues = data;
return cachedIssues;
}

/**
* Very simple text matching:
*/
export function findMatchingIssues(description, limit = 5) {
if (!description || typeof description !== "string") {
return [];
}

const text = description.toLowerCase();
const issues = loadIssues();

const scored = issues
.map((issue) => {
const patterns = issue.symptom_patterns || [];
let score = 0;

for (const p of patterns) {
if (!p) continue;
const phrase = String(p).toLowerCase();
if (phrase.length < 3) continue;

if (text.includes(phrase)) {
score += 2; // full phrase match
} else {
const tokens = phrase.split(/\s+/);
for (const t of tokens) {
if (t.length < 3) continue;
if (text.includes(t)) score += 1;
}
}
}

return { issue, score };
})
.filter((item) => item.score > 0)
.sort((a, b) => b.score - a.score)
.slice(0, limit)
.map((item) => ({
id: item.issue.id,
system: item.issue.system,
symptom_short: item.issue.symptom_short,
symptom_patterns: item.issue.symptom_patterns,
likely_causes: item.issue.likely_causes,
severity: item.issue.severity,
}));

return scored;
}

// default export بسيط علشان import في diagnose.js
const autoKnowledge = {
version: "1.0",
description:
"Helper utilities for matching driver descriptions to common auto issues.",
};

export default autoKnowledge;
