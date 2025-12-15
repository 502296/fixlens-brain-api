// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
  if (cachedIssues) return cachedIssues;

  const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");
  const raw = fs.readFileSync(filePath, "utf-8");
  cachedIssues = JSON.parse(raw);
  return cachedIssues;
}

function normalize(s) {
  return (s || "").toLowerCase().trim();
}

export function findRelevantIssues(text) {
  const issues = loadIssues();
  const t = normalize(text);

  if (!t) return [];

  const matches = [];
  for (const issue of issues) {
    const patterns = issue.symptom_patterns || [];
    const hit = patterns.some((p) => t.includes(normalize(p)));
    if (hit) matches.push(issue);
  }

  // خليها مختصرة حتى لا ينتفخ الـ prompt
  return matches.slice(0, 6);
}
