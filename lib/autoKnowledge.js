// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cache = null;

export function loadIssues() {
  if (cache) return cache;

  const file = path.join(process.cwd(), "data", "auto_common_issues.json");
  const data = fs.readFileSync(file, "utf8");
  cache = JSON.parse(data);
  return cache;
}

export function findRelevantIssues(text) {
  const issues = loadIssues();
  const t = text.toLowerCase();

  return issues.filter((issue) =>
    issue.symptom_patterns.some((p) => t.includes(p.toLowerCase()))
  );
}
