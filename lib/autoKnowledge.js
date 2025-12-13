// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cachedIssues = null;

function loadIssuesSafe() {
  if (cachedIssues) return cachedIssues;

  try {
    const filePath = path.join(process.cwd(), "auto_common_issues.json");
    const raw = fs.readFileSync(filePath, "utf8");
    cachedIssues = JSON.parse(raw);
    return cachedIssues;
  } catch (e) {
    console.error("auto_common_issues.json is invalid:", e.message);
    cachedIssues = []; // 👈 لا توقف التطبيق
    return cachedIssues;
  }
}

export function findRelevantIssues(text) {
  const issues = loadIssuesSafe();
  // (خلي منطق المطابقة عندك هنا مثل ما هو)
  return issues;
}
