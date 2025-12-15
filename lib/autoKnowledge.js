// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
  if (cachedIssues) return cachedIssues;

  // جرّب مكانين شائعين:
  const candidates = [
    path.join(process.cwd(), "data", "auto_common_issues.json"),
    path.join(process.cwd(), "auto_common_issues.json"),
  ];

  let found = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      found = p;
      break;
    }
  }

  if (!found) {
    cachedIssues = [];
    return cachedIssues;
  }

  const raw = fs.readFileSync(found, "utf8");
  cachedIssues = JSON.parse(raw);
  return cachedIssues;
}

export function findRelevantIssues(text, limit = 6) {
  const issues = loadIssues();
  if (!text || !text.trim()) return [];

  const t = text.toLowerCase();
  const scored = [];

  for (const issue of issues) {
    const patterns = issue.symptom_patterns || [];
    let score = 0;

    for (const p of patterns) {
      if (!p) continue;
      const needle = String(p).toLowerCase();
      if (needle && t.includes(needle)) score += 2;
    }

    if (issue.symptom_short && t.includes(String(issue.symptom_short).toLowerCase())) {
      score += 1;
    }

    if (score > 0) scored.push({ score, issue });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.issue);
}
