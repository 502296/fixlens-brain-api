// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssuesSafe() {
  if (cachedIssues) return cachedIssues;

  try {
    // ✅ الملف الآن داخل data/
    const filePath = path.join(process.cwd(), "data", "auto_common_issues.json");
    const raw = fs.readFileSync(filePath, "utf8");
    cachedIssues = JSON.parse(raw);
    if (!Array.isArray(cachedIssues)) cachedIssues = [];
    return cachedIssues;
  } catch (e) {
    console.error("auto_common_issues.json load/parse error:", e?.message || e);
    cachedIssues = [];
    return cachedIssues;
  }
}

// matching بسيط وعملي
export function findRelevantIssues(text = "", limit = 6) {
  const issues = loadIssuesSafe();
  const hay = String(text || "").toLowerCase();

  const scored = issues
    .map((it) => {
      const patterns = Array.isArray(it?.symptom_patterns) ? it.symptom_patterns : [];
      let score = 0;

      for (const p of patterns) {
        const pat = String(p || "").toLowerCase().trim();
        if (!pat) continue;
        if (hay.includes(pat)) score += 3;
      }

      // bonus لو symptom_short موجود
      const short = String(it?.symptom_short || "").toLowerCase();
      if (short && hay.includes(short)) score += 2;

      return { it, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.it);

  return scored;
}
