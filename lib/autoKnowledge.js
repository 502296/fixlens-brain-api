// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function loadIssuesSafe() {
  if (cachedIssues) return cachedIssues;

  try {
    // ✅ Try data/ first, then root
    const p1 = path.join(process.cwd(), "data", "auto_common_issues.json");
    const p2 = path.join(process.cwd(), "auto_common_issues.json");

    const filePath = fileExists(p1) ? p1 : p2;

    const raw = fs.readFileSync(filePath, "utf8");
    const json = JSON.parse(raw);

    if (!Array.isArray(json)) throw new Error("auto_common_issues.json must be an array");
    cachedIssues = json;
    return cachedIssues;
  } catch (e) {
    console.error("auto_common_issues.json load failed:", e.message);
    cachedIssues = [];
    return cachedIssues; // don't crash API
  }
}

/**
 * Return top matched issues based on symptom_patterns occurrences.
 * Each issue expected shape:
 * { id, system, symptom_short, symptom_patterns: [], likely_causes: [] }
 */
export function findRelevantIssues(text = "", limit = 5) {
  const issues = loadIssuesSafe();
  const t = (text || "").toLowerCase();

  if (!t.trim() || !issues.length) return [];

  const scored = [];

  for (const issue of issues) {
    const patterns = Array.isArray(issue.symptom_patterns) ? issue.symptom_patterns : [];
    let score = 0;
    const hits = [];

    for (const p of patterns) {
      const pat = String(p || "").toLowerCase().trim();
      if (!pat) continue;

      // simple contains matching (fast + reliable)
      if (t.includes(pat)) {
        score += 3;
        hits.push(pat);
      }
    }

    // boost if symptom_short appears
    const short = String(issue.symptom_short || "").toLowerCase();
    if (short && t.includes(short)) score += 2;

    if (score > 0) {
      scored.push({
        id: issue.id,
        system: issue.system,
        symptom_short: issue.symptom_short,
        score,
        matched_patterns: hits.slice(0, 8),
        likely_causes: Array.isArray(issue.likely_causes) ? issue.likely_causes : [],
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // keep top N
  return scored.slice(0, Math.max(1, limit));
}
