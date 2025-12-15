// lib/autoKnowledge.js
// Loads ALL JSON files in /data and finds relevant issues by symptom matching.

import fs from "fs";
import path from "path";

let CACHE = {
  loaded: false,
  issues: [],   // normalized list
  files: [],    // filenames loaded
};

function safeJsonParse(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${path.basename(filePath)}: ${e.message}`);
  }
}

function normalizeIssue(issue, sourceFile) {
  // Support different schemas gracefully
  const id = issue.id || issue.code || issue.key || `${sourceFile}:${Math.random().toString(16).slice(2)}`;
  const system = issue.system || issue.category || issue.domain || path.basename(sourceFile, ".json");

  const symptomShort =
    issue.symptom_short ||
    issue.symptom ||
    issue.title ||
    issue.name ||
    "";

  const patterns =
    issue.symptom_patterns ||
    issue.patterns ||
    issue.keywords ||
    [];

  const causes =
    issue.likely_causes ||
    issue.causes ||
    [];

  const checks =
    issue.quick_checks ||
    issue.checks ||
    issue.diagnostic_steps ||
    issue.steps ||
    [];

  const fixes =
    issue.recommended_fixes ||
    issue.fixes ||
    issue.repairs ||
    [];

  const severity = issue.severity || issue.risk || null;
  const urgency = issue.urgency || issue.priority || null;

  return {
    id,
    system,
    source_file: sourceFile,
    symptom_short: String(symptomShort || "").trim(),
    symptom_patterns: Array.isArray(patterns) ? patterns.map(String) : [],
    likely_causes: Array.isArray(causes) ? causes : [],
    quick_checks: Array.isArray(checks) ? checks : [],
    recommended_fixes: Array.isArray(fixes) ? fixes : [],
    severity,
    urgency,
  };
}

function loadAllIssues() {
  if (CACHE.loaded) return CACHE;

  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    throw new Error(`Missing /data folder at ${dataDir}`);
  }

  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  const all = [];

  for (const file of files) {
    const fullPath = path.join(dataDir, file);
    const json = safeJsonParse(fullPath);

    if (Array.isArray(json)) {
      for (const item of json) {
        all.push(normalizeIssue(item, file));
      }
    } else if (json && typeof json === "object" && Array.isArray(json.issues)) {
      for (const item of json.issues) {
        all.push(normalizeIssue(item, file));
      }
    } else {
      // ignore unknown shapes, but don't crash
      // you can later standardize schemas if you want
    }
  }

  CACHE = {
    loaded: true,
    issues: all,
    files,
  };

  return CACHE;
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreMatch(userText, patterns) {
  const t = String(userText || "").toLowerCase();
  if (!t.trim()) return 0;

  let score = 0;

  for (const p of patterns || []) {
    const pat = String(p || "").toLowerCase().trim();
    if (!pat) continue;

    // Exact phrase match gets big score
    if (t.includes(pat)) {
      score += 12;
      continue;
    }

    // Token overlap fallback
    const ptoks = tokenize(pat);
    if (ptoks.length) {
      let hits = 0;
      for (const tok of ptoks) {
        if (tok.length < 3) continue;
        if (t.includes(tok)) hits++;
      }
      score += hits * 2;
    }
  }

  return score;
}

// Main function used by API
export function findRelevantIssues(userMessage, opts = {}) {
  const { maxResults = 6, minScore = 6 } = opts;

  const { issues } = loadAllIssues();

  const scored = issues
    .map((iss) => {
      const patterns = [
        ...(iss.symptom_patterns || []),
        ...(iss.symptom_short ? [iss.symptom_short] : []),
      ];
      const score = scoreMatch(userMessage, patterns);
      return { ...iss, score };
    })
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return scored;
}

export function getKnowledgeStats() {
  const { files, issues } = loadAllIssues();
  return { files_count: files.length, issues_count: issues.length, files };
}
