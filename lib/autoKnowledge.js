// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
if (cachedIssues) return cachedIssues;

try {
// نحاول أولاً داخل مجلّد data/
const candidatePaths = [
path.join(process.cwd(), "data", "auto_common_issues.json"),
// ولو ما لقيناها هناك، نحاول في الروت مباشرة
path.join(process.cwd(), "auto_common_issues.json"),
];

let filePath = null;
for (const p of candidatePaths) {
if (fs.existsSync(p)) {
filePath = p;
break;
}
}

if (!filePath) {
console.error(
"[autoKnowledge] auto_common_issues.json not found in data/ or project root."
);
cachedIssues = [];
return cachedIssues;
}

const raw = fs.readFileSync(filePath, "utf8");
cachedIssues = JSON.parse(raw);
return cachedIssues;
} catch (err) {
console.error("[autoKnowledge] Failed to load issues:", err);
// لو صار خطأ، نخليها مصفوفة فاضية حتى ما نكسر الـ API
cachedIssues = [];
return cachedIssues;
}
}

/**
* يحاول يلاقي أقرب مشاكل بناءً على وصف المستخدم.
* يرجّع نص مختصر نضيفه للـ prompt.
*/
export function findRelevantIssues(description) {
if (!description) return "";

const issues = loadIssues();
if (!issues || !issues.length) return "";

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
