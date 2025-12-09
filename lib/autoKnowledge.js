// lib/autoKnowledge.js
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
* يحاول يلاقي أقرب مشاكل بناءً على وصف المستخدم.
* يرجّع نص مختصر نضيفه للـ prompt.
*/
export function findRelevantIssues(description) {
if (!description) return "";

const issues = loadIssues();
const lowerDesc = description.toLowerCase();

const matches = issues.filter((issue) => {
if (!issue.symptom_patterns) return false;
return issue.symptom_patterns.some((p) =>
lowerDesc.includes(String(p).toLowerCase())
);
});

if (!matches.length) return "";

const lines = matches.slice(0, 3).map((m) => {
const causes = (m.likely_causes || [])
.slice(0, 3)
.map((c) => `- ${c.cause} (probability: ${c.probability})`)
.join("\n");

return `Issue: ${m.symptom_short}\n${causes}`;
});

return `
Auto-knowledge matches (from FixLens internal database):
${lines.join("\n\n")}
`;
}
