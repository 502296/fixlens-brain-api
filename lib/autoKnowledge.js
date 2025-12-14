// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssuesSafe() {
  if (cachedIssues) return cachedIssues;

  try {
    const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");
    const raw = fs.readFileSync(filePath, "utf8");
    cachedIssues = JSON.parse(raw);

    if (!Array.isArray(cachedIssues)) cachedIssues = [];
    return cachedIssues;
  } catch (e) {
    console.error("auto_common_issues.json load failed:", e.message);
    cachedIssues = [];
    return cachedIssues;
  }
}

/**
 * Simple scoring match:
 * - counts matches for symptom_patterns and symptom_short/system keywords
 * - returns top N issues
 */
export function findRelevantIssues(text = "", topN = 6) {
  const issues = loadIssuesSafe();
  const t = (text || "").toLowerCase();

  if (!t.trim() || issues.length === 0) return [];

  const scored = [];

  for (const issue of issues) {
    let score = 0;

    const patterns = Array.isArray(issue.symptom_patterns)
      ? issue.symptom_patterns
      : [];

    for (const p of patterns) {
      const pp = (p || "").toLowerCase().trim();
      if (!pp) continue;

      // exact substring match
      if (t.includes(pp)) score += 3;
      else {
        // partial keyword match (split by space)
        const parts = pp.split(/\s+/).filter(Boolean);
        const hits = parts.filter(k => k.length >= 4 && t.includes(k)).length;
        if (hits >= 2) score += 2;
        else if (hits === 1) score += 1;
      }
    }

    const short = (issue.symptom_short || "").toLowerCase();
    if (short && t.includes(short)) score += 2;

    const system = (issue.system || "").toLowerCase();
    if (system && t.includes(system)) score += 1;

    if (score > 0) {
      scored.push({
        ...issue,
        match_score: score,
      });
    }
  }

  scored.sort((a, b) => b.match_score - a.match_score);
  return scored.slice(0, topN);
}
