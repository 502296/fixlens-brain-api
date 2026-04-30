// diagnosticEngine.js
// FixLens Diagnostic Engine v1.2 — High-Intelligence Multi-Language Core
// Optimized for English & Spanish mechanical forensics.

import usEngineIntel from "./data/us_engine_intel_v1.json" assert { type: "json" };

const OBD_CODE_REGEX = /\b[PBCU][0-9]{4}\b/gi;

const GENERAL_SIGNAL_RULES = [
{ key: "cold_start", terms: ["cold start", "when cold", "cold engine", "startup", "on startup", "first start", "arranque en frío", "motor frío", "al arrancar"] },
{ key: "warm_engine", terms: ["when warm", "after warm up", "warm engine", "hot engine", "after driving", "motor caliente", "después de calentar", "en caliente"] },
{ key: "idle", terms: ["idle", "at idle", "while idling", "rough idle", "idling", "ralentí", "en ralentí", "estacionado", "vibración en parado"] },
{ key: "acceleration", terms: ["acceleration", "accelerating", "under load", "press gas", "when i accelerate", "under throttle", "al acelerar", "aceleración", "bajo carga"] },
{ key: "highway", terms: ["highway", "freeway", "at 60 mph", "at 70 mph", "at speed", "on the road", "carretera", "en autopista", "velocidad de crucero"] },
{ key: "misfire", terms: ["misfire", "rough running", "cutting out", "hesitation", "fallo de encendido", "tirones", "pérdida de chispa", "titubeo"] },
{ key: "rattle", terms: ["rattle", "metallic rattle", "chain rattle", "startup rattle", "traqueteo", "ruido de cadena", "cascabeleo"] },
{ key: "tick", terms: ["tick", "ticking", "tapping", "lifter tick", "tic-tac", "taqués", "golpeteo ligero"] },
{ key: "knock", terms: ["knock", "knocking", "engine knock", "detonación", "golpeteo", "picado de bielas"] },
{ key: "timing_noise", terms: ["timing noise", "timing fault", "timing chain", "cam phaser", "phaser", "ruido de distribución", "cadena de tiempo", "variador de fase"] },
{ key: "top_end_noise", terms: ["top end noise", "top end knock", "top end ticking", "valvetrain", "parte superior del motor", "ruido de válvulas"] },
{ key: "persistent", terms: ["persistent", "constant", "always", "all the time", "persistente", "constante", "todo el tiempo"] },
{ key: "intermittent", terms: ["intermittent", "comes and goes", "sometimes", "random", "intermitente", "a veces", "aleatorio"] },
{ key: "hard_start", terms: ["hard start", "long crank", "starts hard", "cranks long", "arranque difícil", "arranque pesado", "tarda en arrancar"] },
{ key: "no_start", terms: ["no start", "won't start", "does not start", "will not start", "no arranca", "no enciende"] },
{ key: "stalling", terms: ["stall", "stalls", "shuts off", "dies at idle", "se apaga", "se cala", "muere en ralentí"] },
{ key: "smoke", terms: ["smoke", "white smoke", "blue smoke", "black smoke", "humo", "humo blanco", "humo azul", "humo negro"] },
{ key: "overheating", terms: ["overheat", "overheating", "running hot", "temperature high", "sobrecalentamiento", "calentamiento", "temperatura alta"] },
];

const CODE_HINTS = [
{
pattern: /^P030[0-9]$|^P0300$/i,
adds: ["misfire"],
boosts: ["AFM lifter collapse", "AFM oil-control instability", "Spark plug fouling", "Ignition coil failure"],
},
{
pattern: /^P001[0-9]$|^P002[0-9]$/i,
adds: ["timing_noise"],
boosts: ["Timing chain stretch", "Timing guide wear progression", "Cam phaser wear / phaser knock", "VVT solenoid failure"],
},
];

/* =========================================================
CORE LOGIC (PRESERVED & ENHANCED)
========================================================= */

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

function severityWeight(severity = "") {
const s = String(severity).toLowerCase();
if (s === "high") return 1.35; // Increased weight for urgent safety
if (s === "medium") return 1.05;
return 0.85;
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
issueBoosts.set(issueName, (issueBoosts.get(issueName) || 0) + 1.5);
}
}
}
}

if (/check engine|luz del motor|testigo/i.test(text)) {
signalSet.add("check_engine");
}

return { signals: Array.from(signalSet), issueBoosts };
}

function scoreKeywordMatch(normalizedUserText, keyword) {
const k = normalizeText(keyword);
if (!k || !normalizedUserText.includes(k)) return 0;

// Intelligent weighting based on term complexity
if (k.length >= 20) return 3.0;
if (k.length >= 12) return 2.4;
return 1.5;
}

function scoreIssue(issue, ctx) {
const { normalizedUserText, signalWeights, engineBoost, issueBoosts, obdCodes } = ctx;
const matchedKeywords = [];
let score = 0;

for (const keyword of Array.isArray(issue.keywords) ? issue.keywords : []) {
const s = scoreKeywordMatch(normalizedUserText, keyword);
if (s > 0) {
matchedKeywords.push(keyword);
score += s;
}
}

// Boost for exact issue match
const issueNameNorm = normalizeText(issue.name || "");
if (issueNameNorm && normalizedUserText.includes(issueNameNorm)) score += 3.5;

// PH.D LEVEL CORRELATION LOGIC
const mech = normalizeText(issue.mechanism || "");
if (mech.includes("cold") && signalWeights.cold_start) score += 1.2;
if (mech.includes("warm") && signalWeights.warm_engine) score += 1.2;
if (mech.includes("idle") && signalWeights.idle) score += 1.0;
if (mech.includes("timing") && signalWeights.timing_noise) score += 1.5;

if (issueBoosts.has(issue.name)) score += issueBoosts.get(issue.name);

score += engineBoost;
score *= severityWeight(issue.severity);

return {
score: Number(score.toFixed(2)),
matchedKeywords: uniqueStrings(matchedKeywords),
};
}

function normalizeConfidence(rawTopScore = 0, evidenceCount = 0, gapScore = 0) {
let base = 0.25;
if (rawTopScore >= 12) base = 0.92;
else if (rawTopScore >= 8) base = 0.82;
else if (rawTopScore >= 4) base = 0.65;

if (evidenceCount >= 3) base += 0.05;
return Math.max(0.20, Math.min(0.98, Number(base.toFixed(2))));
}

export function runDiagnosticEngine({ userText = "" } = {}) {
const database = Array.isArray(usEngineIntel) ? usEngineIntel : [];
const normalizedUserText = normalizeText(userText);

if (!normalizedUserText) {
return { scope: "engine", topIssue: null, confidence: 0.0, rankedFindings: [] };
}

const detectedCodes = extractObdCodes(userText);
const baseSignals = detectGeneralSignals(userText);
const { signals, issueBoosts } = applyCodeHints(detectedCodes, baseSignals, userText);

// Weights construction
const signalWeights = {};
signals.forEach(s => signalWeights[s] = 1);

// Cross-reference with database (Optimized)
const ranked = [];
database.forEach(engineEntry => {
const engineName = normalizeText(engineEntry.engine || "");
const engineBoost = normalizedUserText.includes(engineName) ? 8 : 0;

engineEntry.issues?.forEach(issue => {
const result = scoreIssue(issue, {
normalizedUserText,
signalWeights,
engineBoost,
issueBoosts,
obdCodes: detectedCodes,
});

if (result.score > 0) {
ranked.push({
engine: engineEntry.engine,
issueName: issue.name,
severity: issue.severity,
score: result.score,
matchedKeywords: result.matchedKeywords,
mechanism: issue.mechanism,
firstChecks: issue.first_checks || [],
symptomNotes: issue.symptom_notes || []
});
}
});
});

ranked.sort((a, b) => b.score - a.score);
const top = ranked[0] || null;
const confidence = top ? normalizeConfidence(top.score, signals.length, 0) : 0.2;

return {
scope: "engine",
detectedCodes,
matchedSignals: signals,
topIssue: top?.issueName || null,
topEngine: top?.engine || null,
confidence,
riskLevel: top?.severity || "low",
matchedKeywords: top?.matchedKeywords || [],
mechanism: top?.mechanism || "",
firstChecks: top?.firstChecks || [],
rankedFindings: ranked.slice(0, 5)
};
}
