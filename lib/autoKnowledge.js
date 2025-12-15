// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssues() {
  if (cachedIssues) return cachedIssues;

  // ✅ الملف عندك داخل data/auto_common_issues.json
  const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");

  const raw = fs.readFileSync(filePath, "utf8");
  cachedIssues = JSON.parse(raw);
  return cachedIssues;
}

/**
 * Find relevant issues using simple pattern matching.
 * Returns top matches.
 */
export function findRelevantIssues(userText, limit = 6) {
  try {
    const issues = loadIssues();
    const text = (userText || "").toLowerCase();

    if (!text.trim()) return [];

    const matches = [];

    for (const issue of issues) {
      const patterns = issue?.symptom_patterns || [];
      let score = 0;

      for (const p of patterns) {
        if (!p) continue;
        const pat = String(p).toLowerCase();
        if (pat && text.includes(pat)) score += 2;
      }

      // Bonus if system keyword appears
      const sys = String(issue?.system || "").toLowerCase();
      if (sys && text.includes(sys)) score += 1;

      if (score > 0) {
        matches.push({ score, issue });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit).map((m) => m.issue);
  } catch (e) {
    return [];
  }
}
