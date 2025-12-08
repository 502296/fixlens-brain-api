// lib/autoKnowledge.js

// Helper to load and match common auto issues from JSON

// يعمل مع ملف واحد ضخم: data/auto_common_issues.json



import fs from "fs";

import path from "path";



let cachedIssues = null;



/**

 * Normalize text for matching:

 * - toLowerCase

 * - remove accents/diacritics

 * - remove extra spaces

 */

function normalizeText(input) {

  if (!input) return "";

  return input

    .toString()

    .normalize("NFD")

    .replace(/[\u0300-\u036f]/g, "") // remove diacritics

    .toLowerCase()

    .replace(/[\r\n]+/g, " ")

    .replace(/\s+/g, " ")

    .trim();

}



/**

 * Safely ensure an array.

 */

function toArray(value) {

  if (!value) return [];

  if (Array.isArray(value)) return value;

  return [value];

}



/**

 * Try to derive a simple category if not provided.

 */

function inferCategory(issue) {

  if (issue.category) return issue.category;



  const sys = (issue.system || "").toLowerCase();

  switch (sys) {

    case "engine":

      return "ENGINE — GENERAL";

    case "cooling":

      return "COOLING SYSTEM";

    case "brakes":

      return "BRAKES & ABS";

    case "electrical":

      return "ELECTRICAL & CHARGING";

    case "wheels_tires":

      return "WHEELS & TIRES";

    case "suspension":

      return "SUSPENSION & STEERING";

    case "transmission":

      return "TRANSMISSION & DRIVELINE";

    case "fuel_system":

      return "FUEL SYSTEM";

    case "exhaust":

      return "EXHAUST & EMISSIONS";

    case "hvac":

      return "HVAC & COMFORT";

    case "body":

      return "BODY & INTERIOR";

    case "high_voltage":

      return "HIGH VOLTAGE (HV)";

    case "driveline":

      return "DRIVELINE & DIFFERENTIAL";

    case "general":

      return "GENERAL VEHICLE";

    case "network":

      return "NETWORK / CAN BUS";

    default:

      return "GENERAL DIAGNOSIS";

  }

}



/**

 * Normalize a single issue object coming from auto_common_issues.json

 * لأن الملف يحتوي أنواع مختلفة:

 * - likely_causes / possible_causes

 * - symptom_short / symptom

 */

function normalizeIssue(raw, index) {

  if (!raw || typeof raw !== "object") return null;



  const id = raw.id || `issue_${index}`;



  // unify symptom fields

  const symptom_short = raw.symptom_short || raw.symptom || "";

  const symptom_patterns = toArray(raw.symptom_patterns);



  // unify cause fields

  const likely_causes =

    Array.isArray(raw.likely_causes) && raw.likely_causes.length > 0

      ? raw.likely_causes

      : Array.isArray(raw.possible_causes)

      ? raw.possible_causes

      : [];



  const recommended_checks = toArray(raw.recommended_checks);

  const safety_warning = raw.safety_warning || "";



  const system = raw.system || "general";

  const category = inferCategory(raw);

  const title =

    raw.title ||

    symptom_short ||

    id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());



  // نصوص للماتش

  const searchBlob = normalizeText(

    [

      id,

      system,

      category,

      title,

      symptom_short,

      symptom_patterns.join(" "),

    ].join(" | ")

  );



  return {

    id,

    system,

    category,

    title,

    symptom_short,

    symptom_patterns,

    likely_causes,

    recommended_checks,

    safety_warning,

    _searchBlob: searchBlob,

  };

}



/**

 * Load & cache all issues from data/auto_common_issues.json

 * الملف يجب أن يكون: array of objects

 */

export function loadIssues() {

  if (cachedIssues) return cachedIssues;



  try {

    const filePath = path.join(

      process.cwd(),

      "data",

      "auto_common_issues.json"

    );



    const raw = fs.readFileSync(filePath, "utf8");

    let parsed = [];



    try {

      parsed = JSON.parse(raw);

    } catch (e) {

      console.error(

        "[autoKnowledge] Failed to parse auto_common_issues.json:",

        e

      );

      parsed = [];

    }



    if (!Array.isArray(parsed)) {

      console.error(

        "[autoKnowledge] auto_common_issues.json is not an array. Check JSON format."

      );

      parsed = [];

    }



    cachedIssues = parsed

      .map((item, idx) => normalizeIssue(item, idx))

      .filter(Boolean);



    console.log(

      `[autoKnowledge] Loaded ${cachedIssues.length} issues from auto_common_issues.json`

    );

  } catch (err) {

    console.error(

      "[autoKnowledge] Error reading data/auto_common_issues.json:",

      err

    );

    cachedIssues = [];

  }



  return cachedIssues;

}



/**

 * Compute a match score between user description and an issue.

 * تعتمد على:

 * - تطابق جملة كاملة من symptom_patterns

 * - تطابق جزئي لكلمات من patterns

 * - تطابق مع title / symptom_short / category

 */

function computeIssueScore(issue, normalizedUserText) {

  if (!normalizedUserText) return 0;



  let score = 0;



  // 1) full pattern matches

  for (const pattern of issue.symptom_patterns || []) {

    const pNorm = normalizeText(pattern);

    if (!pNorm) continue;



    if (normalizedUserText.includes(pNorm)) {

      // full pattern string found

      score += 4;

    } else {

      // جزئي: لكل كلمة موجودة نزيد نقطة

      const words = pNorm.split(" ");

      let partialHits = 0;

      for (const w of words) {

        if (w && normalizedUserText.includes(w)) {

          partialHits += 1;

        }

      }

      if (partialHits > 0) {

        score += Math.min(partialHits, 3);

      }

    }

  }



  // 2) symptom_short / title

  const importantFields = [

    issue.symptom_short,

    issue.title,

    issue.category,

    issue.system,

  ];



  for (const field of importantFields) {

    const fNorm = normalizeText(field);

    if (!fNorm) continue;



    if (normalizedUserText.includes(fNorm)) {

      score += 3;

    } else {

      const words = fNorm.split(" ");

      let hits = 0;

      for (const w of words) {

        if (w && normalizedUserText.includes(w)) {

          hits++;

        }

      }

      if (hits >= 2) {

        score += hits; // boost multi-word match

      }

    }

  }



  // 3) خفيف من الsearchBlob (id, نصوص إضافية)

  if (issue._searchBlob && normalizedUserText) {

    const words = issue._searchBlob.split(" ");

    let extraHits = 0;

    for (const w of words) {

      if (w.length > 4 && normalizedUserText.includes(w)) {

        extraHits++;

      }

    }

    if (extraHits > 0) {

      score += Math.min(extraHits, 4);

    }

  }



  return score;

}



/**

 * Find best matching issues for a given user description.

 * options:

 * - topN (default 5)

 * - minScore (default 1)

 */

export function findBestIssueMatches(description, options = {}) {

  const { topN = 5, minScore = 1 } = options;



  const issues = loadIssues();

  const normText = normalizeText(description);



  if (!normText || !issues.length) {

    return [];

  }



  const scored = issues

    .map((issue) => {

      const score = computeIssueScore(issue, normText);

      return { issue, score };

    })

    .filter((x) => x.score >= minScore)

    .sort((a, b) => b.score - a.score)

    .slice(0, topN);



  return scored;

}



/**

 * Build a compact summary for LLM / GPT prompt.

 * ترجع شكل مناسب نرسله لـ GPT:

 * - لا نرجع _searchBlob ولا معلومات داخلية

 */

export function buildIssueSummaryForLLM(description, options = {}) {

  const matches = findBestIssueMatches(description, options);



  return {

    query: description,

    matches: matches.map(({ issue, score }) => ({

      id: issue.id,

      system: issue.system,

      category: issue.category,

      title: issue.title,

      symptom_short: issue.symptom_short,

      symptom_patterns: issue.symptom_patterns,

      likely_causes: issue.likely_causes || [],

      recommended_checks: issue.recommended_checks || [],

      safety_warning: issue.safety_warning || "",

      match_score: score,

    })),

  };

}



/**

 * Group issues by system (useful لو حبيت تبني كاتيجوري في واجهة FixLens).

 */

export function groupIssuesBySystem() {

  const issues = loadIssues();

  const groups = {};



  for (const issue of issues) {

    const key = issue.system || "general";

    if (!groups[key]) groups[key] = [];

    groups[key].push(issue);

  }



  return groups;

}



/**

 * Default export (لو احتجته بهذه الطريقة)

 */

export default {

  loadIssues,

  findBestIssueMatches,

  buildIssueSummaryForLLM,

  groupIssuesBySystem,

};
