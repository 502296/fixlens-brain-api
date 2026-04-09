// diagnosticEngine.js
// FixLens Diagnostic Engine v1
// Data-first diagnostic core for engine-related issues

import enginePatterns from "./data/engine_patterns.json" assert { type: "json" };
import noisePatterns from "./data/patterns_engine_noise.json" assert { type: "json" };
import failureActions from "./data/failure_actions.json" assert { type: "json" };

const SIGNAL_RULES = [
  { key: "shaking", terms: ["shake", "shaking", "vibration", "vibrates", "رجفة", "رجة", "اهتزاز"] },
  { key: "rough_idle", terms: ["rough idle", "idle rough", "unstable idle", "idle vibration", "رجفة على الوقوف", "اهتزاز على السكون"] },
  { key: "acceleration", terms: ["accelerating", "acceleration", "under load", "when i press gas", "عند الدعس", "عند التسارع"] },
  { key: "deceleration", terms: ["deceleration", "when slowing down", "عند التهدئة", "عند تخفيف السرعة"] },
  { key: "engine_noise", terms: ["engine noise", "knocking", "ticking", "rattle", "humming", "صوت بالمحرك", "طقطقة", "رجة مع صوت"] },
  { key: "power_loss", terms: ["loss of power", "no power", "weak acceleration", "ضعف عزم", "ضعف سحب"] },
  { key: "stalling", terms: ["stall", "stalls", "shuts off", "ينطفي", "تطفى"] },
  { key: "hard_start", terms: ["hard start", "long crank", "starts hard", "تشغيل صعب", "يطول بالتشغيل"] },
  { key: "no_start", terms: ["won't start", "no start", "does not start", "ما تشتغل", "ما تدق"] },
  { key: "smoke", terms: ["smoke", "white smoke", "blue smoke", "black smoke", "دخان", "دخان أبيض", "دخان أسود"] },
  { key: "check_engine", terms: ["check engine", "engine light", "لمبة المكينة", "check engine light"] },
  { key: "hot_engine", terms: ["overheating", "hot", "temperature high", "حرارة مرتفعة", "يسخن"] },
];

const SPEED_PATTERNS = [
  { regex: /\b([4-9]\d|1[0-3]\d)\s?(mph)\b/i, normalize: (m) => `speed_${m[1]}_mph` },
  { regex: /\b([6-9]\d|1[0-9]\d|2[0-2]\d)\s?(km\/h|kph|kmh)\b/i, normalize: (m) => `speed_${m[1]}_kmh` },
];

function normalizeText(input = "") {
  return String(input)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSignals(text) {
  const normalized = normalizeText(text);
  const signals = new Set();

  for (const rule of SIGNAL_RULES) {
    if (rule.terms.some((term) => normalized.includes(term.toLowerCase()))) {
      signals.add(rule.key);
    }
  }

  for (const pattern of SPEED_PATTERNS) {
    const match = normalized.match(pattern.regex);
    if (match) {
      signals.add(pattern.normalize(match));
      signals.add("speed_related");
    }
  }

  return {
    normalized,
    signals: Array.from(signals),
  };
}

function buildPatternLibrary() {
  const engine = Array.isArray(enginePatterns) ? enginePatterns : [];
  const noise = Array.isArray(noisePatterns) ? noisePatterns : [];
  return [...engine, ...noise];
}

function scorePattern(pattern, signals) {
  const signalSet = new Set(signals);
  const required = Array.isArray(pattern.conditions) ? pattern.conditions : [];
  const optional = Array.isArray(pattern.optional_conditions) ? pattern.optional_conditions : [];

  let score = 0;
  let matched = [];

  for (const cond of required) {
    if (signalSet.has(cond)) {
      score += 2.0;
      matched.push(cond);
    }
  }

  for (const cond of optional) {
    if (signalSet.has(cond)) {
      score += 1.0;
      matched.push(cond);
    }
  }

  const requiredHits = required.filter((c) => signalSet.has(c)).length;
  const requiredRatio = required.length ? requiredHits / required.length : 0;

  return {
    rawScore: score,
    requiredRatio,
    matched,
  };
}

function mergeCauseScores(patterns, signals) {
  const causeMap = new Map();

  for (const pattern of patterns) {
    const { rawScore, requiredRatio, matched } = scorePattern(pattern, signals);
    if (rawScore <= 0) continue;

    const causes = Array.isArray(pattern.possible_causes) ? pattern.possible_causes : [];
    const weight = typeof pattern.weight === "number" ? pattern.weight : 1;

    for (const cause of causes) {
      const existing = causeMap.get(cause) || {
        key: cause,
        score: 0,
        matchedSignals: new Set(),
        supportingPatterns: [],
      };

      const total = rawScore * weight * (0.5 + requiredRatio);
      existing.score += total;
      matched.forEach((m) => existing.matchedSignals.add(m));
      existing.supportingPatterns.push(pattern.pattern || pattern.name || "unknown_pattern");

      causeMap.set(cause, existing);
    }
  }

  return Array.from(causeMap.values())
    .map((item) => ({
      ...item,
      matchedSignals: Array.from(item.matchedSignals),
    }))
    .sort((a, b) => b.score - a.score);
}

function normalizeConfidence(score) {
  if (score >= 10) return 0.92;
  if (score >= 8) return 0.86;
  if (score >= 6) return 0.77;
  if (score >= 4) return 0.66;
  if (score >= 2.5) return 0.54;
  return 0.38;
}

function resolveRecommendedChecks(causeKey) {
  if (!causeKey) return [];
  const entry = failureActions[causeKey];

  if (!entry) return [];

  if (Array.isArray(entry)) return entry.slice(0, 5);

  if (Array.isArray(entry.actions)) return entry.actions.slice(0, 5);

  if (Array.isArray(entry.checks)) return entry.checks.slice(0, 5);

  return [];
}

function inferRiskLevel(topCause, signals) {
  const set = new Set(signals);

  if (set.has("hot_engine") || set.has("smoke")) return "high";
  if (set.has("stalling") || set.has("no_start")) return "high";

  const mediumCauses = [
    "ignition_misfire",
    "fuel_delivery_issue",
    "vacuum_leak",
    "timing_issue",
  ];

  if (mediumCauses.includes(topCause)) return "medium";

  return "low";
}

export function runDiagnosticEngine({ userText = "", scope = "engine" } = {}) {
  const { normalized, signals } = extractSignals(userText);

  const library = buildPatternLibrary();

  const rankedCauses = mergeCauseScores(library, signals);
  const top = rankedCauses[0] || null;

  const topCause = top?.key || null;
  const confidence = top ? normalizeConfidence(top.score) : 0.2;
  const recommendedChecks = resolveRecommendedChecks(topCause);
  const riskLevel = inferRiskLevel(topCause, signals);

  return {
    scope,
    normalizedText: normalized,
    matchedSignals: signals,
    topCause,
    confidence,
    riskLevel,
    rankedCauses: rankedCauses.slice(0, 5).map((c) => ({
      key: c.key,
      score: Number(c.score.toFixed(2)),
      matchedSignals: c.matchedSignals,
      supportingPatterns: c.supportingPatterns.slice(0, 3),
    })),
    recommendedChecks,
  };
}
