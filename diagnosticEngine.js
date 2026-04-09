// diagnosticEngine.js
// FixLens Diagnostic Engine v1.1
// Data-first engine diagnosis core
// Optimized for us_engine_intel_v1.json structure

import usEngineIntel from "./data/us_engine_intel_v1.json" assert { type: "json" };

const OBD_CODE_REGEX = /\b[PBCU][0-9]{4}\b/gi;

const GENERAL_SIGNAL_RULES = [
  { key: "cold_start", terms: ["cold start", "when cold", "cold engine", "startup", "on startup", "first start", "بارد", "تشغيل بارد", "عند التشغيل"] },
  { key: "warm_engine", terms: ["when warm", "after warm up", "warm engine", "hot engine", "after driving", "بعد ما يسخن", "وهو حار"] },
  { key: "idle", terms: ["idle", "at idle", "while idling", "rough idle", "idling", "واقف", "سلانسية", "على الوقوف"] },
  { key: "acceleration", terms: ["acceleration", "accelerating", "under load", "press gas", "when i accelerate", "under throttle", "عند الدعس", "عند التسارع"] },
  { key: "highway", terms: ["highway", "freeway", "at 60 mph", "at 70 mph", "at speed", "on the road", "على الخط", "على السرعة"] },
  { key: "misfire", terms: ["misfire", "rough running", "cutting out", "hesitation", "تقطيع", "تفتفة", "ميسفاير"] },
  { key: "rattle", terms: ["rattle", "metallic rattle", "chain rattle", "startup rattle", "خشخشة", "رجة", "صوت جنزير", "صوت حديد"] },
  { key: "tick", terms: ["tick", "ticking", "tapping", "lifter tick", "طقطقة", "تك تك", "تكايات"] },
  { key: "knock", terms: ["knock", "knocking", "engine knock", "دق", "دكدكة"] },
  { key: "timing_noise", terms: ["timing noise", "timing fault", "timing chain", "cam phaser", "phaser", "صوت توقيت", "صوت جنزير", "فايزر"] },
  { key: "top_end_noise", terms: ["top end noise", "top end knock", "top end ticking", "valvetrain", "فوق المكينة", "من فوق المكينة"] },
  { key: "persistent", terms: ["persistent", "constant", "always", "all the time", "مستمر", "دائم"] },
  { key: "intermittent", terms: ["intermittent", "comes and goes", "sometimes", "random", "متقطع", "يجي ويروح"] },
  { key: "hard_start", terms: ["hard start", "long crank", "starts hard", "cranks long", "تشغيل صعب", "يطول بالتشغيل"] },
  { key: "no_start", terms: ["no start", "won't start", "does not start", "will not start", "ما يشتغل", "ما تدق", "ما تشتغل"] },
  { key: "stalling", terms: ["stall", "stalls", "shuts off", "dies at idle", "ينطفي", "يبطل"] },
  { key: "smoke", terms: ["smoke", "white smoke", "blue smoke", "black smoke", "دخان", "دخان ابيض", "دخان أبيض", "دخان اسود", "دخان أسود"] },
  { key: "overheating", terms: ["overheat", "overheating", "running hot", "temperature high", "يسخن", "حرارة مرتفعة"] },
];

const CODE_HINTS = [
  {
    pattern: /^P030[0-9]$|^P0300$/i,
    adds: ["misfire"],
    boosts: ["AFM lifter collapse", "AFM oil-control instability"],
  },
  {
    pattern: /^P001[0-9]$|^P002[0-9]$/i,
    adds: ["timing_noise"],
    boosts: ["Timing chain stretch", "Timing guide wear progression", "Cam phaser wear / phaser knock"],
  },
];

function normalizeText(input = "") {
  return String(input)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s./:-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(arr = []) {
  return [...new Set((arr || []).filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];
}

function severityToRisk(severity = "") {
  const s = String(severity).toLowerCase();
  if (s === "high") return "high";
  if (s === "medium") return "medium";
  return "low";
}

function severityWeight(severity = "") {
  const s = String(severity).toLowerCase();
  if (s === "high") return 1.28;
  if (s === "medium") return 1.0;
  return 0.82;
}

function extractObdCodes(text = "") {
  const matches = String(text).match(OBD_CODE_REGEX) || [];
  return uniqueStrings(matches.map((m) => m.toUpperCase()));
}

function detectGeneralSignals(text) {
  const normalized = normalizeText(text);
  const found = new Set();

  for (const rule of GENERAL_SIGNAL_RULES) {
    if (rule.terms.some((term) => normalized.includes(normalizeText(term)))) {
      found.add(rule.key);
    }
  }

  if (/\b([5-9]\d|1[0-2]\d)\s?mph\b/i.test(text)) found.add("highway");
  if (/\bcold\b/i.test(text) && !found.has("cold_start")) found.add("cold_start");
  if (/\bwarm\b|\bhot\b/i.test(text) && !found.has("warm_engine")) found.add("warm_engine");

  return Array.from(found);
}

function applyCodeHints(codes = [], signals = [], text = "") {
  const signalSet = new Set(signals);
  const issueBoosts = new Map();

  for (const code of codes) {
    for (const hint of CODE_HINTS) {
      if (hint.pattern.test(code)) {
        for (const sig of hint.adds || []) signalSet.add(sig);
        for (const issueName of hint.boosts || []) {
          issueBoosts.set(issueName, (issueBoosts.get(issueName) || 0) + 1.25);
        }
      }
    }
  }

  if (String(text).toLowerCase().includes("check engine")) {
    signalSet.add("check_engine");
  }

  return {
    signals: Array.from(signalSet),
    issueBoosts,
  };
}

function detectEngineMatches(text, database) {
  const normalized = normalizeText(text);

  return database
    .map((entry) => {
      const engineName = normalizeText(entry.engine || "");
      if (!engineName) return { engine: entry.engine, score: 0 };

      let score = 0;

      if (normalized.includes(engineName)) score += 7;

      const tokens = engineName.split(" ").filter((t) => t.length > 1);
      let hits = 0;

      for (const token of tokens) {
        if (normalized.includes(token)) hits += 1;
      }

      if (hits >= 2) score += Math.min(hits, 4);

      return {
        engine: entry.engine,
        score,
      };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildSignalWeights(signals = []) {
  const set = new Set(signals);

  return {
    cold_start: set.has("cold_start") ? 1 : 0,
    warm_engine: set.has("warm_engine") ? 1 : 0,
    idle: set.has("idle") ? 1 : 0,
    acceleration: set.has("acceleration") ? 1 : 0,
    highway: set.has("highway") ? 1 : 0,
    misfire: set.has("misfire") ? 1 : 0,
    rattle: set.has("rattle") ? 1 : 0,
    tick: set.has("tick") ? 1 : 0,
    knock: set.has("knock") ? 1 : 0,
    timing_noise: set.has("timing_noise") ? 1 : 0,
    top_end_noise: set.has("top_end_noise") ? 1 : 0,
    persistent: set.has("persistent") ? 1 : 0,
    intermittent: set.has("intermittent") ? 1 : 0,
    hard_start: set.has("hard_start") ? 1 : 0,
    no_start: set.has("no_start") ? 1 : 0,
    stalling: set.has("stalling") ? 1 : 0,
    smoke: set.has("smoke") ? 1 : 0,
    overheating: set.has("overheating") ? 1 : 0,
  };
}

function scoreKeywordMatch(normalizedUserText, keyword) {
  const k = normalizeText(keyword);
  if (!k) return 0;

  if (!normalizedUserText.includes(k)) return 0;

  if (k.length >= 22) return 2.8;
  if (k.length >= 14) return 2.2;
  if (k.length >= 8) return 1.7;
  return 1.2;
}

function scoreIssue(issue, ctx) {
  const {
    normalizedUserText,
    signalWeights,
    engineBoost,
    issueBoosts,
    obdCodes,
  } = ctx;

  const matchedKeywords = [];
  let score = 0;

  for (const keyword of Array.isArray(issue.keywords) ? issue.keywords : []) {
    const s = scoreKeywordMatch(normalizedUserText, keyword);
    if (s > 0) {
      matchedKeywords.push(keyword);
      score += s;
    }
  }

  const issueNameNorm = normalizeText(issue.name || "");
  if (issueNameNorm && normalizedUserText.includes(issueNameNorm)) {
    score += 3.2;
  }

  const mechanism = normalizeText(issue.mechanism || "");
  const notes = Array.isArray(issue.symptom_notes) ? issue.symptom_notes.map(normalizeText) : [];

  if (mechanism.includes("cold") && signalWeights.cold_start) score += 0.95;
  if (mechanism.includes("warm") && signalWeights.warm_engine) score += 0.95;
  if (mechanism.includes("idle") && signalWeights.idle) score += 0.8;
  if (mechanism.includes("misfire") && signalWeights.misfire) score += 1.05;
  if (mechanism.includes("timing") && signalWeights.timing_noise) score += 1.15;
  if (mechanism.includes("oil") && (normalizedUserText.includes("oil") || normalizedUserText.includes("زيت"))) score += 0.65;

  for (const note of notes) {
    if (note.includes("cold") && signalWeights.cold_start) score += 0.8;
    if (note.includes("warm") && signalWeights.warm_engine) score += 0.8;
    if (note.includes("idle") && signalWeights.idle) score += 0.75;
    if (note.includes("misfire") && signalWeights.misfire) score += 0.95;
    if (note.includes("tick") && signalWeights.tick) score += 0.75;
    if (note.includes("rattle") && signalWeights.rattle) score += 0.95;
    if (note.includes("persistent") && signalWeights.persistent) score += 0.8;
    if (note.includes("intermittent") && signalWeights.intermittent) score += 0.8;
    if (note.includes("startup") && signalWeights.cold_start) score += 0.7;
  }

  if (signalWeights.acceleration && /(load|acceleration|throttle)/i.test(issue.mechanism || "")) {
    score += 0.7;
  }

  if (signalWeights.highway && /(load|drivability|misfire)/i.test(issue.mechanism || "")) {
    score += 0.55;
  }

  if (issueBoosts.has(issue.name)) {
    score += issueBoosts.get(issue.name);
  }

  if (obdCodes.length > 0) {
    if (/timing|phaser|chain/i.test(issue.name || "") && obdCodes.some((c) => /^P00(1|2)/i.test(c))) {
      score += 1.35;
    }
    if (/misfire|lifter/i.test(issue.name || "") && obdCodes.some((c) => /^P030/i.test(c))) {
      score += 1.35;
    }
  }

  score += engineBoost;
  score *= severityWeight(issue.severity);

  return {
    score: Number(score.toFixed(2)),
    matchedKeywords: uniqueStrings(matchedKeywords),
  };
}

function normalizeConfidence(rawTopScore = 0, evidenceCount = 0, gapScore = 0) {
  let base = 0.22;

  if (rawTopScore >= 14) base = 0.95;
  else if (rawTopScore >= 11) base = 0.9;
  else if (rawTopScore >= 8.5) base = 0.83;
  else if (rawTopScore >= 6.5) base = 0.74;
  else if (rawTopScore >= 4.5) base = 0.63;
  else if (rawTopScore >= 3) base = 0.52;

  if (evidenceCount >= 4) base += 0.03;
  else if (evidenceCount <= 1) base -= 0.04;

  if (gapScore >= 3) base += 0.03;
  else if (gapScore <= 0.6) base -= 0.05;

  return Math.max(0.18, Math.min(0.97, Number(base.toFixed(2))));
}

function inferRiskLevel(topIssue = {}, signals = [], codes = []) {
  const signalSet = new Set(signals);
  const issueName = String(topIssue?.issueName || "");
  const severity = String(topIssue?.severity || "").toLowerCase();

  if (signalSet.has("overheating") || signalSet.has("smoke")) return "high";
  if (signalSet.has("no_start") || signalSet.has("stalling")) return "high";
  if (codes.some((c) => /^P030/i.test(c)) && signalSet.has("acceleration")) return "high";
  if (severity === "high") return "high";
  if (/timing|chain|phaser|lifter/i.test(issueName)) return "medium";

  return "low";
}

function buildCautionFlags(topIssue = {}, signals = [], codes = []) {
  const flags = [];
  const name = String(topIssue?.issueName || "");

  if (/timing chain|guide wear|cam phaser/i.test(name)) {
    flags.push("timing-risk");
  }
  if (/lifter/i.test(name)) {
    flags.push("mechanical-valvetrain-risk");
  }
  if (codes.some((c) => /^P030/i.test(c))) {
    flags.push("misfire-cluster");
  }
  if (signals.includes("overheating")) {
    flags.push("overheat-risk");
  }

  return flags;
}

export function runDiagnosticEngine({ userText = "" } = {}) {
  const database = Array.isArray(usEngineIntel) ? usEngineIntel : [];
  const normalizedUserText = normalizeText(userText);

  if (!normalizedUserText) {
    return {
      scope: "engine",
      normalizedText: "",
      engineHints: [],
      detectedCodes: [],
      matchedSignals: [],
      topIssue: null,
      topEngine: null,
      confidence: 0.0,
      riskLevel: "low",
      matchedKeywords: [],
      firstChecks: [],
      mechanism: "",
      symptomNotes: [],
      commonMisreads: [],
      doNotConfuseWith: [],
      rankedFindings: [],
      cautionFlags: [],
    };
  }

  const detectedCodes = extractObdCodes(userText);
  const baseSignals = detectGeneralSignals(userText);
  const { signals, issueBoosts } = applyCodeHints(detectedCodes, baseSignals, userText);
  const signalWeights = buildSignalWeights(signals);
  const engineMatches = detectEngineMatches(userText, database);

  const ranked = [];

  for (const engineEntry of database) {
    const engineBoost = engineMatches.find((m) => m.engine === engineEntry.engine)?.score || 0;
    const issues = Array.isArray(engineEntry.issues) ? engineEntry.issues : [];

    for (const issue of issues) {
      const result = scoreIssue(issue, {
        normalizedUserText,
        signalWeights,
        engineBoost,
        issueBoosts,
        obdCodes: detectedCodes,
      });

      if (result.score <= 0) continue;

      ranked.push({
        engine: engineEntry.engine,
        issueName: issue.name || "Unknown issue",
        severity: issue.severity || "medium",
        score: result.score,
        matchedKeywords: result.matchedKeywords,
        mechanism: issue.mechanism || "",
        symptomNotes: Array.isArray(issue.symptom_notes) ? issue.symptom_notes : [],
        commonMisreads: Array.isArray(issue.common_misreads) ? issue.common_misreads : [],
        firstChecks: Array.isArray(issue.first_checks) ? issue.first_checks : [],
        doNotConfuseWith: Array.isArray(issue.do_not_confuse_with) ? issue.do_not_confuse_with : [],
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const top = ranked[0] || null;
  const second = ranked[1] || null;
  const evidenceCount = uniqueStrings([
    ...(top?.matchedKeywords || []),
    ...signals,
    ...detectedCodes,
  ]).length;
  const gapScore = top ? (top.score - (second?.score || 0)) : 0;
  const confidence = top ? normalizeConfidence(top.score, evidenceCount, gapScore) : 0.18;
  const riskLevel = inferRiskLevel(top || {}, signals, detectedCodes);
  const cautionFlags = buildCautionFlags(top || {}, signals, detectedCodes);

  return {
    scope: "engine",
    normalizedText: normalizedUserText,
    engineHints: engineMatches.slice(0, 3),
    detectedCodes,
    matchedSignals: signals,
    topIssue: top ? top.issueName : null,
    topEngine: top ? top.engine : null,
    confidence,
    riskLevel,
    matchedKeywords: top ? top.matchedKeywords : [],
    firstChecks: top ? top.firstChecks.slice(0, 5) : [],
    mechanism: top ? top.mechanism : "",
    symptomNotes: top ? top.symptomNotes.slice(0, 4) : [],
    commonMisreads: top ? top.commonMisreads.slice(0, 4) : [],
    doNotConfuseWith: top ? top.doNotConfuseWith.slice(0, 4) : [],
    cautionFlags,
    rankedFindings: ranked.slice(0, 5).map((item, index) => ({
      rank: index + 1,
      engine: item.engine,
      issueName: item.issueName,
      severity: item.severity,
      score: item.score,
      confidence: index === 0 ? confidence : Math.max(0.18, Number((confidence - 0.08 * index).toFixed(2))),
      matchedKeywords: item.matchedKeywords,
    })),
  };
}
