// lib/autoKnowledge.js
// Helper for searching inside data/auto_common_issues.json

import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
if (cachedIssues) return cachedIssues;

const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");

const raw = fs.readFileSync(filePath, "utf8");
cachedIssues = JSON.parse(raw);

return cachedIssues;
}

/**
* Find matching issues based on the user's description.
* - description: free text from the driver
* - maxResults: how many issues to return
*/
export function findMatchingIssues(description, maxResults = 5) {
const issues = loadIssues();
const text = (description || "").toLowerCase();

const scored = issues.map((issue) => {
let score = 0;

if (Array.isArray(issue.symptom_patterns)) {
for (const pattern of issue.symptom_patterns) {
const p = String(pattern || "").toLowerCase();
if (!p) continue;

// تطابق مباشر للجملة
if (text.includes(p)) {
score += 3;
} else {
// تطابق على مستوى الكلمات
const words = p.split(/\s+/).filter(Boolean);
if (words.length && words.every((w) => text.includes(w))) {
score += 1;
}
}
}
}

return { issue, score };
});

return scored
.filter((item) => item.score > 0)
.sort((a, b) => b.score - a.score)
.slice(0, maxResults)
.map((item) => item.issue);
}
