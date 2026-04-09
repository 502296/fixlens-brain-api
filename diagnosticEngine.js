// diagnosticEngine.js
// FixLens Diagnostic Engine v1
// Built for engine-intel style data:
// [
//   {
//     engine: "5.4L 3V Triton",
//     issues: [
//       {
//         name,
//         keywords,
//         severity,
//         mechanism,
//         symptom_notes,
//         common_misreads,
//         first_checks,
//         do_not_confuse_with
//       }
//     ]
//   }
// ]

import usEngineIntel from "./data/us_engine_intel_v1.json" assert { type: "json" };

function normalizeText(input = "") {
  return String(input)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s./-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(arr = []) {
  return [...new Set(arr.filter(Boolean).map(String))];
}

function severityToRisk(severity = "") {
  const s = String(severity).toLowerCase();
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

function severityWeight(severity = "") {
  const s = String(severity).toLowerCase();
  if (s === "high") return 1.25;
  if (s === "medium") return 1.0;
  return 0.8;
}

function normalizeConfidence(score = 0) {
  if (score >= 12) return 0.94;
  if (score >= 10) return 0.89;
  if (score >= 8) return 0.83;
  if (score >= 6) return 0.75;
  if (score >= 4) return 0.64;
  if (score >= 2.5) return 0.52;
  return 0.32;
}

function detectGeneralSignals(text) {
  const normalized = normalizeText(text);
  const signals = new Set();

  const signalRules = [
    { key: "cold_start", terms: ["cold start", "when cold", "startup", "on startup", "cold engine", "بارد", "عند التشغيل", "تشغيل بارد"] },
    { key: "warm_idle", terms: ["warm idle", "when warm", "hot idle", "after warm up", "بعد ما يسخن", "وهو حار", "بعد التسخين"] },
    { key: "idle", terms: ["idle", "at idle", "while idling", "واقف", "على السلانسية", "على الوقوف"] },
    { key: "acceleration", terms: ["acceleration", "accelerating", "under load", "press gas", "when i accelerate", "عند الدعس", "عند التسارع"] },
    { key: "misfire", terms: ["misfire", "rough running", "rough idle", "تقطيع", "تفتفة", "ميسفاير"] },
    { key: "rattle", terms: ["rattle", "metallic rattle", "chain rattle", "خشخشة", "رجة", "صوت جنزير", "صوت حديد"] },
    { key: "tick", terms: ["tick", "ticking", "tapping", "طقطقة", "تك تك", "تكايات"] },
    { key: "knock", terms: ["knock", "knocking", "دق", "دكدكة", "knock at idle"] },
    { key: "timing_noise", terms: ["timing noise", "timing fault", "صوت توقيت", "صوت جنزير", "chain noise"] },
    { key: "top_end_noise", terms: ["top end noise", "top end knock", "top end ticking", "فوق المكينة", "من فوق المكينة"] },
    { key: "persistent", terms: ["persistent", "constant", "always", "مستمر", "دائم"] },
    { key: "intermittent", terms: ["intermittent", "comes and goes", "sometimes", "متقطع", "يجي ويروح"] },
  ];

  for (const rule of signalRules) {
    if (rule.terms.some((term) => normalized.includes(normalizeText(term)))) {
      signals.add(rule.key);
    }
  }

  return Array.from(signals);
}

function detectEngineMatches(text, database) {
  const normalized = normalizeText(text);

  return database
    .map((entry) => {
      const engineName = normalizeText(entry.engine || "");
      let score = 0;

      if (engineName && normalized.includes(engineName)) {
        score += 6;
      }

      const engineTokens = engineName.split(" ").filter((t) => t.length > 1);
      let tokenHits = 0;

      for (const token of engineTokens) {
        if (normalized.includes(token)) tokenHits += 1;
      }

      if (tokenHits >= 2) {
        score += Math.min(tokenHits, 4);
      }

      return {
        engine: entry.engine,
        score,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function scoreIssue(issue, userText, generalSignals = [], engineBoost = 0) {
  const normalized = normalizeText(userText);
  const matchedKeywords = [];
  let score = 0;

  const keywords = Array.isArray(issue.keywords) ? issue.keywords : [];

  for (const keyword of keywords) {
    const k = normalizeText(keyword);
    if (!k) continue;

    if (normalized.includes(k)) {
      matchedKeywords.push(keyword);

      const lenWeight =
        k.length >= 18 ? 2.5 :
        k.length >= 10 ? 2.0 :
        1.4;

      score += lenWeight;
    }
  }

  const name = normalizeText(issue.name || "");
  if (name && normalized.includes(name)) {
    score += 3;
  }

  const mechanism = normalizeText(issue.mechanism || "");
  if (mechanism) {
    if (mechanism.includes("timing") && generalSignals.includes("timing_noise")) score += 1.2;
    if (mechanism.includes("misfire") && generalSignals.includes("misfire")) score += 1.2;
    if (mechanism.includes("idle") && generalSignals.includes("idle")) score += 0.8;
    if (mechanism.includes("warm") && generalSignals.includes("warm_idle")) score += 0.8;
    if (mechanism.includes("cold") && generalSignals.includes("cold_start")) score += 0.8;
  }

  const notes = Array.isArray(issue.symptom_notes) ? issue.symptom_notes.map(normalizeText) : [];
  for (const note of notes) {
    if (!note) continue;
    if (note.includes("cold") && generalSignals.includes("cold_start")) score += 0.8;
    if (note.includes("warm") && generalSignals.includes("warm_idle")) score += 0.8;
    if (note.includes("idle") && generalSignals.includes("idle")) score += 0.7;
    if (note.includes("misfire") && generalSignals.includes("misfire")) score += 0.9;
    if (note.includes("tick") && generalSignals.includes("tick")) score += 0.7;
    if (note.includes("rattle") && generalSignals.includes("rattle")) score += 0.9;
    if (note.includes("persistent") && generalSignals.includes("persistent")) score += 0.8;
    if (note.includes("intermittent") && generalSignals.includes("intermittent")) score += 0.8;
  }

  score *= severityWeight(issue.severity);
  score += engineBoost;

  return {
    rawScore: score,
    matchedKeywords: uniqueStrings(matchedKeywords),
  };
}

function rankIssues(userText, database) {
  const generalSignals = detectGeneralSignals(userText);
  const engineMatches = detectEngineMatches(userText, database);

  const ranked = [];

  for (const engineEntry of database) {
    const engineBoostEntry =
      engineMatches.find((m) => m.engine === engineEntry.engine) || null;

    const engineBoost = engineBoostEntry ? engineBoostEntry.score : 0;

    const issues = Array.isArray(engineEntry.issues) ? engineEntry.issues : [];

    for (const issue of issues) {
      const { rawScore, matchedKeywords } = scoreIssue(
        issue,
        userText,
        generalSignals,
        engineBoost
      );

      if (rawScore <= 0) continue;

      ranked.push({
        engine: engineEntry.engine,
        issueName: issue.name || "Unknown issue",
        severity: issue.severity || "medium",
        riskLevel: severityToRisk(issue.severity),
        score: Number(rawScore.toFixed(2)),
        confidence: normalizeConfidence(rawScore),
        matchedKeywords,
        matchedSignals: generalSignals,
        mechanism: issue.mechanism || "",
        symptomNotes: Array.isArray(issue.symptom_notes) ? issue.symptom_notes : [],
        commonMisreads: Array.isArray(issue.common_misreads) ? issue.common_misreads : [],
        firstChecks: Array.isArray(issue.first_checks) ? issue.first_checks : [],
        doNotConfuseWith: Array.isArray(issue.do_not_confuse_with)
          ? issue.do_not_confuse_with
          : [],
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  return {
    ranked,
    generalSignals,
    engineMatches,
  };
}

export function runDiagnosticEngine({ userText = "" } = {}) {
  const database = Array.isArray(usEngineIntel) ? usEngineIntel : [];
  const normalizedText = normalizeText(userText);

  if (!normalizedText) {
    return {
      scope: "engine",
      normalizedText: "",
      topIssue: null,
      topEngine: null,
      confidence: 0.0,
      riskLevel: "low",
      matchedSignals: [],
      matchedKeywords: [],
      rankedFindings: [],
      firstChecks: [],
      mechanism: "",
      commonMisreads: [],
      doNotConfuseWith: [],
    };
  }

  const { ranked, generalSignals, engineMatches } = rankIssues(userText, database);
  const top = ranked[0] || null;

  return {
    scope: "engine",
    normalizedText,
    engineHints: engineMatches.slice(0, 3),
    matchedSignals: generalSignals,
    topIssue: top ? top.issueName : null,
    topEngine: top ? top.engine : null,
    confidence: top ? top.confidence : 0.18,
    riskLevel: top ? top.riskLevel : "low",
    matchedKeywords: top ? top.matchedKeywords : [],
    firstChecks: top ? top.firstChecks.slice(0, 5) : [],
    mechanism: top ? top.mechanism : "",
    symptomNotes: top ? top.symptomNotes.slice(0, 4) : [],
    commonMisreads: top ? top.commonMisreads.slice(0, 4) : [],
    doNotConfuseWith: top ? top.doNotConfuseWith.slice(0, 4) : [],
    rankedFindings: ranked.slice(0, 5).map((item) => ({
      engine: item.engine,
      issueName: item.issueName,
      severity: item.severity,
      riskLevel: item.riskLevel,
      score: item.score,
      confidence: item.confidence,
      matchedKeywords: item.matchedKeywords,
      matchedSignals: item.matchedSignals,
    })),
  };
}
