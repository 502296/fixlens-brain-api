// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssuesSafe() {
  if (cachedIssues) return cachedIssues;

  const candidates = [
    path.join(process.cwd(), "data", "auto_common_issues.json"),
    path.join(process.cwd(), "auto_common_issues.json")
  ];

  for (const filePath of candidates) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      cachedIssues = JSON.parse(raw);
      return cachedIssues;
    } catch (e) {
      // try next path
    }
  }

  console.error("auto_common_issues.json not found or invalid.");
  cachedIssues = [];
  return cachedIssues;
}

export function findRelevantIssues(text = "") {
  const issues = loadIssuesSafe();
  // حالياً نرجّع الكل (وبعدين نرجّع منطق المطابقة)
  return issues;
}
