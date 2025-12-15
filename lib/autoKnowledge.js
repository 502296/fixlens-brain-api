// lib/autoKnowledge.js
// FixLens Brain: AutoKnowledge Loader + Smart Matcher
// - Loads ALL JSON files in /data automatically
// - Matches user text to issues using patterns + token overlap
// - Returns top relevant issues with scores + matched terms
//
// Works on Vercel Node runtime (serverless) as long as files are bundled in repo.

import fs from "fs";
import path from "path";

// -------------------- CACHE --------------------
let _cache = {
  loaded: false,
  files: [],
  issues: [], // normalized list
  bySystem: new Map(),
};

// -------------------- HELPERS --------------------
function safeLower(s) {
  return (s ?? "").toString().toLowerCase();
}

function stripPunctuation(s) {
  return safeLower(s)
    .replace(/[\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const t = stripPunctuation(s);
  if (!t) return [];
  // Keep common automotive tokens like "p0300", "p0171", "dpf", "scr", "def", "nox"
  return t.split(" ").filter(Boolean);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

// -------------------- NORMALIZATION --------------------
// Accepts either:
// - Array of issues
// - Object with { issues: [...] }
// - Object keyed by id -> issue
function normalizeIssues(json, sourceFile) {
  let arr = [];

  if (Array.isArray(json)) {
    arr = json;
  } else if (isObject(json) && Array.isArray(json.issues)) {
    arr = json.issues;
  } else if (isObject(json)) {
    // object map -> issue
    arr = Object.values(json);
  }

  const normalized = [];
  for (const it of arr) {
    if (!it) continue;

    const id = (it.id ?? it.issue_id ?? it.key ?? "").toString().trim();
    const system = (it.system ?? it.category ?? it.domain ?? "").toString().trim();

    const symptomShort =
      (it.symptom_short ?? it.title ?? it.symptom ?? it.name ?? "").toString().trim();

    const symptomPatterns = Array.isArray(it.symptom_patterns)
      ? it.symptom_patterns.map((x) => (x ?? "").toString()).filter(Boolean)
      : [];

    // Optional fields we keep if exist
    const likelyCauses = Array.isArray(it.likely_causes) ? it.likely_causes : [];
    const checks = Array.isArray(it.checks) ? it.checks : [];
    const fixes = Array.isArray(it.fixes) ? it.fixes : [];
    const warnings = Array.isArray(it.warnings) ? it.warnings : [];
    const notes = (it.notes ?? it.description ?? "").toString();

    // For search boosting
    const extraKeywords = Array.isArray(it.keywords)
      ? it.keywords.map((x) => (x ?? "").toString()).filter(Boolean)
      : [];

    const allPatternText = uniq([
      symptomShort,
      ...symptomPatterns,
      ...extraKeywords,
      ...(typeof notes === "string" ? [notes] : []),
    ])
      .filter(Boolean)
      .join(" ");

    const tokens = uniq(tokenize(allPatternText));

    normalized.push({
      id: id || `${path.basename(sourceFile, ".json")}::${normalized.length + 1}`,
      system: system || path.basename(sourceFile, ".json"),
      symptom_short: symptomShort || "",
      symptom_patterns: symptomPatterns,
      likely_causes: likelyCauses,
      checks,
      fixes,
      warnings,
      notes,
      _sourceFile: path.basename(sourceFile),
      _tokens: tokens, // cached tokens for matching
    });
  }

  return normalized;
}

// -------------------- LOAD ALL DATA --------------------
function dataDir() {
  return path.join(process.cwd(), "data");
}

function loadAll() {
  if (_cache.loaded) return _cache;

  const dir = dataDir();

  if (!fs.existsSync(dir)) {
    // If someone renamed or moved folder
    _cache.loaded = true;
    _cache.files = [];
    _cache.issues = [];
    _cache.bySystem = new Map();
    return _cache;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .sort();

  const allIssues = [];
  const bySystem = new Map();

  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const json = readJsonFile(fp);
      const normalized = normalizeIssues(json, fp);

      for (const issue of normalized) {
        allIssues.push(issue);
        const sys = issue.system || "unknown";
        if (!bySystem.has(sys)) bySystem.set(sys, []);
        bySystem.get(sys).push(issue);
      }
    } catch (e) {
      // We skip bad JSON file but keep going
      // eslint-disable-next-line no-console
      console.warn(`[AutoKnowledge] Skipped ${f}: ${e?.message || e}`);
    }
  }

  _cache.loaded = true;
  _cache.files = files;
  _cache.issues = allIssues;
  _cache.bySystem = bySystem;

  return _cache;
}

// -------------------- MATCHING --------------------
// Score signals:
// - exact phrase matches from symptom_patterns (strong)
// - token overlap with issue tokens (medium)
// - code-like tokens (P0xxx, U0xxx, etc) boosted
function scoreIssue(userText, userTokens, issue) {
  const t = safeLower(userText);
  const matched = [];

  let score = 0;

  // 1) Pattern phrase match
  if (Array.isArray(issue.symptom_patterns) && issue.symptom_patterns.length) {
    for (const p of issue.symptom_patterns) {
      const phrase = safeLower(p).trim();
      if (!phrase) continue;
      // Match as substring (works for Arabic/English mix too)
      if (t.includes(phrase)) {
        score += 12;
        matched.push(p);
      }
    }
  }

  // 2) Token overlap
  if (issue._tokens && issue._tokens.length && userTokens.length) {
    const issueTokSet = new Set(issue._tokens);
    let overlap = 0;
    for (const tok of userTokens) {
      if (issueTokSet.has(tok)) overlap++;
    }
    if (overlap > 0) {
      score += Math.min(10, overlap * 2);
      matched.push(...userTokens.filter((x) => issueTokSet.has(x)));
    }
  }

  // 3) OBD / CAN DTC boost (Pxxxx, Uxxxx, Bxxxx, Cxxxx)
  const dtcHits = userTokens.filter((x) => /^[pubc][0-9]{4}$/i.test(x));
  if (dtcHits.length) {
    // If issue mentions the same code anywhere, boost more
    const blob = safeLower(
      `${issue.id} ${issue.symptom_short} ${issue.notes} ${JSON.stringify(issue.likely_causes)}`
    );
    for (const code of dtcHits) {
      if (blob.includes(safeLower(code))) score += 10;
      else score += 3;
      matched.push(code.toUpperCase());
    }
  }

  // 4) Very short but strong signal in symptom_short
  if (issue.symptom_short) {
    const sshort = safeLower(issue.symptom_short);
    if (sshort && t.includes(sshort) && sshort.length >= 8) {
      score += 8;
      matched.push(issue.symptom_short);
    }
  }

  // 5) Tiny bonus for same system keywords
  // Example: user says "abs" -> brakes/air_brakes.
  const sys = safeLower(issue.system);
  if (sys) {
    const sysTokens = tokenize(sys);
    const sysHit = sysTokens.some((x) => userTokens.includes(x));
    if (sysHit) score += 2;
  }

  return {
    score,
    matched_terms: uniq(matched).slice(0, 20),
  };
}

// -------------------- PUBLIC API --------------------
/**
 * Find relevant issues from the FixLens knowledge base.
 *
 * @param {string} userText
 * @param {object} [opts]
 * @param {number} [opts.limit=6] - number of issues to return
 * @param {string[]} [opts.systems] - restrict search to certain systems (e.g. ["engine","electrical"])
 * @param {number} [opts.minScore=6] - minimum score to include
 * @returns {Array} list of best matches
 */
export function findRelevantIssues(userText, opts = {}) {
  const { limit = 6, systems, minScore = 6 } = opts;

  const text = (userText ?? "").toString();
  const userTokens = uniq(tokenize(text));

  const { issues, bySystem } = loadAll();

  let pool = issues;

  if (Array.isArray(systems) && systems.length) {
    const wanted = new Set(systems.map((x) => safeLower(x)));
    const collected = [];
    for (const [sys, list] of bySystem.entries()) {
      if (wanted.has(safeLower(sys))) collected.push(...list);
    }
    pool = collected.length ? collected : issues;
  }

  const scored = [];
  for (const issue of pool) {
    const { score, matched_terms } = scoreIssue(text, userTokens, issue);
    if (score >= minScore) {
      scored.push({
        id: issue.id,
        system: issue.system,
        symptom_short: issue.symptom_short,
        matched_terms,
        score,
        // Keep helpful fields for the LLM prompt
        likely_causes: issue.likely_causes,
        checks: issue.checks,
        fixes: issue.fixes,
        warnings: issue.warnings,
        notes: issue.notes,
        source: issue._sourceFile,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // If nothing matched (user typed "hello" etc.), return empty list
  // so the main model can respond normally without hallucinating.
  return scored.slice(0, clamp(limit, 1, 15));
}

/**
 * Debug helper: returns what files were loaded and how many issues.
 */
export function getKnowledgeStats() {
  const c = loadAll();
  return {
    data_dir: dataDir(),
    files_count: c.files.length,
    files: c.files,
    issues_count: c.issues.length,
    systems_count: c.bySystem.size,
    systems: Array.from(c.bySystem.keys()).sort(),
  };
}
