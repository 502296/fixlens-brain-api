// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
  if (cachedIssues) return cachedIssues;

  const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");
  if (!fs.existsSync(filePath)) {
    cachedIssues = [];
    return cachedIssues;
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  cachedIssues = JSON.parse(raw);
  return cachedIssues;
}

export function findRelevantIssues(text) {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return [];

  const issues = loadIssues();
  const hits = [];

  for (const issue of issues) {
    const patterns = issue?.symptom_patterns || [];
    for (const p of patterns) {
      if (p && t.includes(String(p).toLowerCase())) {
        hits.push(issue);
        break;
      }
    }
    if (hits.length >= 5) break; // كافي
  }

  return hits;
}
