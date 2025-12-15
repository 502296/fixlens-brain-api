// lib/autoKnowledge.js
import fs from "fs";
import path from "path";

let cached = null;

function safeJsonParse(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    return data;
  } catch (e) {
    return null;
  }
}

function normalizeIssue(issue, fileTag = "unknown") {
  if (!issue || typeof issue !== "object") return null;

  const id =
    (issue.id || issue.code || issue.key || `${fileTag}_${Math.random().toString(16).slice(2)}`).toString();

  const system =
    (issue.system || issue.category || issue.domain || fileTag || "general").toString();

  const title =
    (issue.title || issue.symptom_short || issue.name || issue.problem || id).toString();

  const symptom_patterns = Array.isArray(issue.symptom_patterns)
    ? issue.symptom_patterns.map(String)
    : Array.isArray(issue.patterns)
      ? issue.patterns.map(String)
      : [];

  const dtc_patterns = Array.isArray(issue.dtc_patterns)
    ? issue.dtc_patterns.map(String)
    : Array.isArray(issue.dtc)
      ? issue.dtc.map(String)
      : [];

  const likely_causes = Array.isArray(issue.likely_causes)
    ? issue.likely_causes
    : Array.isArray(issue.causes)
      ? issue.causes
      : [];

  const checks = Array.isArray(issue.checks) ? issue.checks : [];
  const fixes = Array.isArray(issue.fixes) ? issue.fixes : [];

  const severity = (issue.severity || issue.risk || "unknown").toString();
  const urgency = (issue.urgency || issue.priority || "unknown").toString();

  return {
    id,
    system,
    title,
    symptom_patterns,
    dtc_patterns,
    likely_causes,
    checks,
    fixes,
    severity,
    urgency,
    source_file: fileTag,
  };
}

function loadAllIssues() {
  if (cached) return cached;

  const dataDir = path.join(process.cwd(), "data");
  const all = [];

  if (!fs.existsSync(dataDir)) {
    cached = [];
    return cached;
  }

  const files = fs.readdirSync(dataDir).filter((f) => f.toLowerCase().endsWith(".json"));

  for (const file of files) {
    const full = path.join(dataDir, file);
    const parsed = safeJsonParse(full);

    // expect array; if object with "issues" array, support it
    const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.issues) ? parsed.issues : null);
    if (!arr) continue;

    const tag = file.replace(".json", "");
    for (const item of arr) {
      const norm = normalizeIssue(item, tag);
      if (norm) all.push(norm);
    }
  }

  cached = all;
  return cached;
}

function scoreIssue(issue, textLower) {
  let score = 0;

  // symptom patterns
  for (const p of issue.symptom_patterns || []) {
    const pl = String(p).toLowerCase().trim();
    if (!pl) continue;
    if (textLower.includes(pl)) score += 6;
  }

  // dtc patterns (exact-ish)
  for (const d of issue.dtc_patterns || []) {
    const dl = String(d).toLowerCase().trim();
    if (!dl) continue;
    if (textLower.includes(dl)) score += 10;
  }

  // boost by system keyword mention
  const sys = (issue.system || "").toLowerCase();
  if (sys && textLower.includes(sys)) score += 2;

  return score;
}

export function findRelevantIssues(userText, { limit = 10 } = {}) {
  const t = (userText || "").toString().toLowerCase();
  if (!t.trim()) return [];

  const issues = loadAllIssues();
  const scored = [];

  for (const issue of issues) {
    const s = scoreIssue(issue, t);
    if (s > 0) scored.push({ issue, score: s });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => ({
    id: x.issue.id,
    system: x.issue.system,
    title: x.issue.title,
    severity: x.issue.severity,
    urgency: x.issue.urgency,
    likely_causes: x.issue.likely_causes,
    checks: x.issue.checks,
    fixes: x.issue.fixes,
    source_file: x.issue.source_file,
    score: x.score,
  }));
}
