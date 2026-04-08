// search.js — FixLens v6.0.0
// Global + data-first + stable fields
// Goals:
// - Search internal KB first using manifest-selected files
// - Match decision-grade action records from failure_actions.json
// - Use Google Places only when local-help intent is clear and allowed
// - Return stable, rich fields for service.js
// - Prefer internal diagnosis intelligence before external lookups
// - Support broader global language / script input without splitting logic by language

import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");
const MANIFEST_PATH = path.join(DATA_DIR, "kb_manifest.json");
const FAILURE_ACTIONS_PATH = path.join(DATA_DIR, "failure_actions.json");

/* =========================================================
   FETCH SAFE
========================================================= */
let _fetch = globalThis.fetch;

async function ensureFetch() {
  if (_fetch) return _fetch;
  const mod = await import("node-fetch");
  _fetch = mod.default;
  return _fetch;
}

/* =========================================================
   CONFIG
========================================================= */
const PLACES_CACHE = new Map();
const KB_CACHE = new Map();
const GEO_CACHE = new Map();

const CACHE_TTL_MS = Number(process.env.PLACES_CACHE_TTL_MS || 10 * 60 * 1000);
const PLACES_TIMEOUT_MS = Number(process.env.PLACES_TIMEOUT_MS || 7000);
const GEO_TIMEOUT_MS = Number(process.env.GEO_TIMEOUT_MS || 5000);
const PLACES_MAX_RESULTS = Number(process.env.PLACES_MAX_RESULTS || 5);
const DEFAULT_RADIUS_METERS = Number(process.env.PLACES_RADIUS_METERS || 25000);
const DEFAULT_KB_RESULTS = Number(process.env.KB_DEFAULT_RESULTS || 4);
const DEFAULT_ACTION_RESULTS = Number(process.env.KB_ACTION_RESULTS || 3);

/* =========================================================
   JSON / FILE HELPERS
========================================================= */
function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];

  for (const item of arr || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* =========================================================
   MANIFEST
========================================================= */
let MANIFEST = null;

function loadManifestOnce() {
  if (MANIFEST) return MANIFEST;

  MANIFEST = safeReadJson(MANIFEST_PATH, null);

  if (!MANIFEST || !Array.isArray(MANIFEST.domains)) {
    MANIFEST = {
      version: "0",
      default_top_k: 10,
      domains: [],
    };
  }

  return MANIFEST;
}

/* =========================================================
   TEXT HELPERS
========================================================= */
function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    ..replace(/[^a-zA-Z0-9\s\-.,،]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLocale(locale = "en") {
  const value = String(locale || "").trim();
  if (!value || value.toLowerCase() === "auto") return "en";
  return value.split("-")[0].toLowerCase() || "en";
}

function hasAny(text = "", words = []) {
  const normalized = normalizeText(text);
  return (Array.isArray(words) ? words : []).some((word) =>
    normalized.includes(normalizeText(word))
  );
}

function tokenize(value = "") {
  return normalizeText(value)
    .split(" ")
    .map((x) => x.trim())
    .filter(Boolean);
}

function extractZip(text = "") {
  const match = String(text || "").match(/\b\d{5}(?:-\d{4})?\b/);
  return match ? match[0] : "";
}

function extractFaultCodes(text = "") {
  const matches =
    String(text || "").match(/\b([PCUB][0-9]{3,4}|[A-Z][0-9]{4})\b/gi) || [];
  return [...new Set(matches.map((x) => x.toUpperCase()))].slice(0, 10);
}

function detectScript(value = "") {
  const text = String(value || "");

  if (/[\u0600-\u06FF]/.test(text)) return "arabic";
  if (/[\u0400-\u04FF]/.test(text)) return "cyrillic";
  if (/[\u4E00-\u9FFF]/.test(text)) return "han";
  if (/[\u3040-\u30FF]/.test(text)) return "japanese";
  if (/[\uAC00-\uD7AF]/.test(text)) return "hangul";
  if (/[\u0900-\u097F]/.test(text)) return "devanagari";
  if (/[A-Za-z]/.test(text)) return "latin";

  return "unknown";
}

function buildSearchSignals(query = "") {
  const q = normalizeText(query);
  const codes = extractFaultCodes(query);

  return {
    normalized: q,
    tokens: tokenize(q),
    codes,
    script: detectScript(query),
    hasDiagnosisWords: hasAny(q, [
      "engine", "misfire", "knock", "noise", "overheat", "coolant", "battery",
      "alternator", "brake", "steering", "abs", "traction", "stability",
      "transmission", "suspension", "leak", "smoke", "rough idle",
      "tick", "ticking", "rattle", "grinding", "squeal", "hum", "vibration",
      "محرك", "تقطيع", "خبط", "حرارة", "فرامل", "دركسون", "بطارية", "دينمو",
      "تعليق", "تهريب", "دخان", "رجفة", "ثبات", "مانع الانغلاق",
      "صوت", "طقطقة", "تك تك", "خشخشة", "صرير", "اهتزاز", "ضعف سحب"
    ]),
    hasPlacesWords: hasAny(q, [
      "near me", "nearby", "closest", "shop", "mechanic", "garage", "repair",
      "address", "location", "map", "maps", "tow", "towing", "parts store",
      "workshop", "specialist",
      "اقرب", "بالقرب", "ورشة", "ميكانيكي", "كراج", "عنوان", "موقع", "خرائط",
      "سطحة", "سحب", "محل قطع", "قطع غيار"
    ]),
    hasPurchaseWords: hasAny(q, [
      "should i buy", "worth buying", "pre purchase", "pre-purchase", "buy this car",
      "اشتريها", "تنصحني اشتري", "قبل لا اشتري", "افحصها قبل الشراء"
    ]),
    hasSafetyWords: hasAny(q, [
      "safe to drive", "can i drive", "is it safe", "dangerous to drive",
      "هل امشي بيها", "هل أسوقها", "آمنة", "أقدر أمشي", "خطر"
    ]),
  };
}

/* =========================================================
   LOCATION HELPERS
========================================================= */
function parseLatLng(input) {
  if (!input) return null;

  if (typeof input === "object" && !Array.isArray(input)) {
    const lat = Number(input.lat ?? input.latitude);
    const lng = Number(input.lng ?? input.longitude ?? input.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng };
    }
  }

  const text = String(input || "").trim();
  const match = text.match(/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/);
  if (!match) return null;

  const lat = Number(match[1]);
  const lng = Number(match[3]);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function safeCityText(userLocation) {
  if (!userLocation) return "";

  if (typeof userLocation === "string") {
    const value = userLocation.trim();
    if (!value || value.toLowerCase() === "global") return "";
    return value;
  }

  if (typeof userLocation === "object" && !Array.isArray(userLocation)) {
    const city =
      userLocation.city ||
      userLocation.locality ||
      userLocation.town ||
      userLocation.name ||
      "";

    const region =
      userLocation.region ||
      userLocation.state ||
      userLocation.adminArea ||
      "";

    const country = userLocation.country || "";

    return [city, region, country].filter(Boolean).join(", ").trim();
  }

  return "";
}

function extractLocationFromQuery(userQuery = "") {
  const query = String(userQuery || "").trim();
  if (!query) return "";

  const zip = extractZip(query);
  if (zip) return zip;

  const gps = parseLatLng(query);
  if (gps) return `${gps.lat},${gps.lng}`;

  const en = query.match(
    /\b(?:in|near|around|at)\s+([A-Za-z][A-Za-z\s.\-']{2,})(?:,\s*([A-Za-z]{2,}))?/i
  );
  if (en) {
    const city = (en[1] || "").trim();
    const region = (en[2] || "").trim();
    const combined = [city, region].filter(Boolean).join(", ");
    if (combined.length >= 3) return combined;
  }

  const ar = query.match(
    /(?:\bفي\b|\bبال\b|\bبـ\b|\bب)(\s*[\p{L},\s.\-]{3,60})/u
  );
  if (ar?.[1]) {
    const candidate = ar[1]
      .replace(/[^\p{L},\s.\-]/gu, " ")
      .trim();
    if (candidate.length >= 3) return candidate;
  }

  return "";
}

function locationLooksUsable(value = "") {
  const v = String(value || "").trim();
  if (!v) return false;
  if (parseLatLng(v)) return true;
  if (extractZip(v)) return true;
  return v.length >= 3;
}

/* =========================================================
   MANIFEST DOMAIN PICKING
========================================================= */
function pickDomainsForQuery(query = "") {
  const manifest = loadManifestOnce();
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const codes = extractFaultCodes(query);

  const scored = (manifest.domains || [])
    .map((domain) => {
      const keywords = Array.isArray(domain.keywords) ? domain.keywords : [];
      let hits = 0;

      for (const keyword of keywords) {
        const normalizedKeyword = normalizeText(keyword);
        if (normalizedKeyword && normalizedQuery.includes(normalizedKeyword)) {
          hits += 1;
        }
      }

      if (codes.length > 0) {
        const codeKeywords = keywords.filter((k) =>
          /^[PCUB]/i.test(String(k || ""))
        );
        for (const codeKeyword of codeKeywords) {
          const nk = normalizeText(codeKeyword);
          if (nk && normalizedQuery.includes(nk)) hits += 3;
        }
      }

      const priority = Number(domain.priority || 0);
      const score = hits * 10 + priority;

      return { domain, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const chosen = scored.slice(0, 3).map((item) => item.domain);

  const meta = (manifest.domains || []).find(
    (domain) => String(domain.id || "") === "meta"
  );

  if (meta && !chosen.some((domain) => domain.id === "meta")) {
    chosen.push(meta);
  }

  return chosen;
}

/* =========================================================
   KB FILE LOADING
========================================================= */
function loadJsonFileAsRecords(fileName) {
  if (!fileName) return [];
  if (KB_CACHE.has(fileName)) return KB_CACHE.get(fileName);

  const filePath = path.join(DATA_DIR, fileName);
  const parsed = safeReadJson(filePath, null);

  let records = [];
  if (Array.isArray(parsed)) {
    records = parsed;
  } else if (parsed?.items && Array.isArray(parsed.items)) {
    records = parsed.items;
  } else if (parsed && typeof parsed === "object") {
    records = [parsed];
  }

  const normalized = records.map((record) => ({
    ...record,
    __source: fileName,
  }));

  KB_CACHE.set(fileName, normalized);
  return normalized;
}

function getKBForDomains(domains = []) {
  const files = uniqBy(
    domains.flatMap((domain) =>
      Array.isArray(domain.files) ? domain.files : []
    ),
    (file) => file
  );

  let output = [];
  for (const file of files) {
    output.push(...loadJsonFileAsRecords(file));
  }

  return output;
}

/* =========================================================
   FAILURE ACTIONS LOADING + MATCHING
========================================================= */
let FAILURE_ACTIONS_CACHE = null;

function loadFailureActions() {
  if (FAILURE_ACTIONS_CACHE) return FAILURE_ACTIONS_CACHE;

  const parsed = safeReadJson(FAILURE_ACTIONS_PATH, []);
  FAILURE_ACTIONS_CACHE = Array.isArray(parsed) ? parsed : [];
  return FAILURE_ACTIONS_CACHE;
}

function normalizeActionText(action = {}) {
  return normalizeText(
    [
      action.id,
      action.match_type,
      action.confidence_boost_if,
      action.kill_other_hypotheses,
      action.actions,
      action.stop_now_if,
      action.ignore_risk,
      action.safety_level,
    ]
      .flat()
      .filter(Boolean)
      .join(" ")
  );
}

function buildActionSignals(query = "") {
  const q = normalizeText(query);

  return {
    normalized: q,
    tokens: tokenize(q),
    codes: extractFaultCodes(query),
    coldStart: hasAny(q, [
      "cold start", "startup", "when cold", "cold engine",
      "بارد", "عند التشغيل", "تشغيل بارد"
    ]),
    warmOnly: hasAny(q, [
      "when warm", "when hot", "after warm up",
      "حار", "بعد ما تحمى", "وهي حارة"
    ]),
    idleOnly: hasAny(q, [
      "at idle", "idle", "rough idle",
      "على الايدل", "على السلانسيه", "واقف"
    ]),
    underLoad: hasAny(q, [
      "under load", "when accelerating", "with throttle", "load",
      "مع الدعس", "وقت الدعس", "تحت الحمل"
    ]),
    decel: hasAny(q, [
      "decel", "lift off", "coast",
      "رفع الدعس", "على الساحبة", "يبطل لما ارفع رجلي"
    ]),
    braking: hasAny(q, [
      "brake", "braking", "pedal",
      "فرامل", "دعسة الفرامل", "بدعس فرامل"
    ]),
    speedRelated: hasAny(q, [
      "at speed", "highway", "road speed", "lane change", "wheel",
      "على السرعة", "على الخط", "تزيد مع السرعة", "عجلة"
    ]),
    noiseWords: hasAny(q, [
      "tick", "ticking", "rattle", "knock", "grind", "grinding",
      "squeal", "hum", "whine", "buzz",
      "طقطقة", "تك تك", "خشخشة", "خبط", "صرير", "ونة", "أزيز", "حك"
    ]),
    misfire: hasAny(q, [
      "misfire", "rough idle", "shake", "shaking", "hesitation",
      "تقطيع", "تفتفة", "تنتيع", "رجفة", "اهتزاز", "يختنق"
    ]),
    overheating: hasAny(q, [
      "overheat", "overheating", "coolant", "radiator",
      "حرارة", "سخونة", "ماء الرديتر", "رديتر"
    ]),
    batteryOrVoltage: hasAny(q, [
      "battery", "alternator", "voltage", "charging",
      "بطارية", "دينمو", "شحن", "فولتية"
    ]),
    safetyWords: hasAny(q, [
      "safe to drive", "dangerous", "stop now", "can i drive",
      "هل امشي بيها", "خطر", "اوقفها", "أكدر أمشي"
    ]),
    purchaseWords: hasAny(q, [
      "should i buy", "worth buying", "pre purchase",
      "اشتريها", "تنصحني اشتري", "قبل لا اشتري"
    ]),
  };
}

function scoreFailureAction(query, action) {
  const signals = buildActionSignals(query);
  const text = normalizeActionText(action);
  const matchTypes = Array.isArray(action?.match_type) ? action.match_type : [];
  const boosts = Array.isArray(action?.confidence_boost_if)
    ? action.confidence_boost_if
    : [];

  let score = 0;

  if (action?.id && signals.normalized.includes(normalizeText(action.id))) {
    score += 20;
  }

  for (const token of signals.tokens) {
    if (token.length < 2) continue;
    if (text.includes(token)) score += token.length >= 4 ? 2 : 1;
  }

  if (signals.noiseWords && matchTypes.some((m) =>
    ["noise", "tick", "rattle", "hum", "whine", "grinding", "squeal", "top_end", "bottom_end", "engine_noise", "belt_drive", "underbody", "wheel_end"].includes(String(m))
  )) {
    score += 8;
  }

  if (signals.misfire && matchTypes.some((m) =>
    ["misfire", "air_fuel", "combustion", "drivability"].includes(String(m))
  )) {
    score += 8;
  }

  if (signals.braking && matchTypes.some((m) =>
    ["brake", "safety_critical"].includes(String(m))
  )) {
    score += 10;
  }

  if (signals.speedRelated && matchTypes.some((m) =>
    ["speed_related", "wheel_end", "underbody"].includes(String(m))
  )) {
    score += 7;
  }

  if (signals.underLoad && boosts.includes("under_load")) score += 6;
  if (signals.coldStart && boosts.includes("cold_start")) score += 6;
  if (signals.warmOnly && boosts.includes("warm_only")) score += 5;
  if (signals.idleOnly && boosts.includes("idle_only")) score += 5;
  if (signals.decel && boosts.includes("decel_noise")) score += 5;

  if (signals.overheating && text.includes("overheat")) score += 8;
  if (signals.batteryOrVoltage && text.includes("battery")) score += 8;

  if (signals.safetyWords && String(action?.safety_level || "").toLowerCase() === "critical") {
    score += 5;
  }

  if (signals.purchaseWords && String(action?.safety_level || "").toLowerCase() !== "low") {
    score += 3;
  }

  score += Number(action?.diagnostic_priority || 0);

  return score;
}

function matchFailureActions(query = "", maxResults = DEFAULT_ACTION_RESULTS) {
  const actions = loadFailureActions();
  if (!query || !Array.isArray(actions) || actions.length === 0) return [];

  const limit = clamp(Number(maxResults || DEFAULT_ACTION_RESULTS), 1, 6);

  const matched = actions
    .map((action) => ({
      ...action,
      match_score: scoreFailureAction(query, action),
    }))
    .filter((action) => action.match_score > 0)
    .sort((a, b) => {
      if (b.match_score !== a.match_score) return b.match_score - a.match_score;
      return Number(b.diagnostic_priority || 0) - Number(a.diagnostic_priority || 0);
    })
    .slice(0, limit);

  return matched.map((action) => ({
    id: action.id || "",
    match_score: action.match_score,
    diagnostic_priority: action.diagnostic_priority || 0,
    match_type: Array.isArray(action.match_type) ? action.match_type : [],
    confidence_boost_if: Array.isArray(action.confidence_boost_if)
      ? action.confidence_boost_if
      : [],
    kill_other_hypotheses: Array.isArray(action.kill_other_hypotheses)
      ? action.kill_other_hypotheses
      : [],
    safety_level: action.safety_level || "",
    actions: Array.isArray(action.actions) ? action.actions : [],
    stop_now_if: Array.isArray(action.stop_now_if) ? action.stop_now_if : [],
    ignore_risk: action.ignore_risk || "",
    source: "failure_actions.json",
  }));
}

/* =========================================================
   LOCAL KB SEARCH
========================================================= */
function recordToText(record) {
  return normalizeText(
    [
      record.title,
      record.problem,
      record.symptom,
      record.description,
      record.likely_causes,
      record.recommended_checks,
      record.steps,
      record.tags,
      record.category,
      record.system,
      record.engine,
      record.issues,
      record.codes,
      record.code,
      record.make,
      record.model,
      record.year,
      record.warning,
      record.risk,
      record.purchase_notes,
      record.subsystem,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function getRecordCodes(record = {}) {
  const out = [];

  if (Array.isArray(record.codes)) out.push(...record.codes);
  if (typeof record.code === "string") out.push(record.code);

  return [...new Set(out.map((x) => String(x || "").toUpperCase()))];
}

function scoreMatch(query, record) {
  const q = normalizeText(query);
  const text = recordToText(record);

  if (!q || !text) return 0;

  const tokens = tokenize(q);
  const queryCodes = extractFaultCodes(query);
  const recordCodes = getRecordCodes(record);

  let score = 0;

  if (text.includes(q)) score += 18;

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (text.includes(token)) score += token.length >= 4 ? 3 : 1;
  }

  for (const code of queryCodes) {
    if (recordCodes.includes(code)) score += 15;
    else if (text.includes(code.toLowerCase())) score += 10;
    else if (text.includes(code.slice(0, 3).toLowerCase())) score += 4;
  }

  if (record.make && q.includes(normalizeText(record.make))) score += 4;
  if (record.model && q.includes(normalizeText(record.model))) score += 5;
  if (record.year && q.includes(String(record.year))) score += 3;

  if (record.system && q.includes(normalizeText(record.system))) score += 4;
  if (record.category && q.includes(normalizeText(record.category))) score += 3;

  return score;
}

function scoreResultQuality(item = {}) {
  let quality = 0;
  if (item.title) quality += 1;
  if (item.causes) quality += 1;
  if (item.checks) quality += 1;
  if (item.steps) quality += 1;
  if (item.tags) quality += 1;
  if (item.raw?.codes || item.raw?.code) quality += 1;
  return quality;
}

function searchLocalKB(query, maxResults = DEFAULT_KB_RESULTS) {
  const domains = pickDomainsForQuery(query);
  const kb = getKBForDomains(domains);

  if (!query || kb.length === 0) return [];

  const limit = clamp(Number(maxResults || DEFAULT_KB_RESULTS), 1, 10);

  const scored = kb
    .map((record) => ({
      record,
      score: scoreMatch(query, record),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return scoreResultQuality({
        raw: b.record,
        title: b.record.title,
        causes: b.record.likely_causes || b.record.causes,
        checks: b.record.recommended_checks || b.record.checks,
        steps: b.record.steps,
        tags: b.record.tags || b.record.category || b.record.system,
      }) - scoreResultQuality({
        raw: a.record,
        title: a.record.title,
        causes: a.record.likely_causes || a.record.causes,
        checks: a.record.recommended_checks || a.record.checks,
        steps: a.record.steps,
        tags: a.record.tags || a.record.category || a.record.system,
      });
    })
    .slice(0, limit * 2);

  const mapped = scored.map(({ record, score }) => ({
    title: record.title || record.problem || "Verified item",
    score,
    source: record.__source || "data",
    causes: record.likely_causes || record.causes || "",
    checks: record.recommended_checks || record.checks || "",
    steps: record.steps || "",
    tags: record.tags || record.category || record.system || "",
    codes: getRecordCodes(record),
    vehicle_fit: [record.year, record.make, record.model, record.engine]
      .filter(Boolean)
      .join(" ")
      .trim(),
    raw: record,
  }));

  return uniqBy(
    mapped.slice(0, limit),
    (item) =>
      `${String(item.title).toLowerCase()}::${item.source}::${(item.codes || []).join(",")}`
  );
}

/* =========================================================
   PLACES INTENT
========================================================= */
function looksLikePlacesIntent(query = "") {
  const text = String(query || "").toLowerCase();

  const shopWords = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "car repair",
    "near me",
    "nearby",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "workshop",
    "specialist",
    "tow",
    "towing",
    "dealer",
    "dealership",
    "inspection shop",
    "prepurchase inspection",

    "ورشة",
    "ورش",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "وين اروح",
    "دلني",
    "سطحة",
    "سحب",
    "فحص قبل الشراء",
  ];

  const partsWords = [
    "auto parts",
    "car parts",
    "parts store",
    "tool store",
    "hardware store",
    "autozone",
    "o'reilly",
    "oreilly",
    "advance auto",
    "napa",
    "قطع غيار",
    "محل قطع",
    "محل قطع غيار",
    "محل ادوات",
    "محل أدوات",
    "ادوات",
    "أدوات",
    "price",
    "prices",
    "cost",
    "سعر",
    "اسعار",
    "تكلفة",
  ];

  return (
    shopWords.some((word) => text.includes(word)) ||
    partsWords.some((word) => text.includes(word))
  );
}

function detectModeFromText(query = "") {
  const text = String(query || "").toLowerCase();

  if (
    hasAny(text, [
      "tire",
      "tyre",
      "اطار",
      "إطار",
      "اطارات",
      "إطارات",
      "بنشر",
      "ترصيص",
    ])
  ) {
    return "tire";
  }

  if (hasAny(text, ["brake", "abs", "فرامل", "هوبات", "سفايف", "مانع الانغلاق"])) {
    return "brake_abs";
  }

  if (
    hasAny(text, [
      "battery",
      "alternator",
      "voltage",
      "electrical",
      "بطارية",
      "دينمو",
      "كهرباء",
    ])
  ) {
    return "electrical";
  }

  if (hasAny(text, ["transmission", "gearbox", "gear", "قير", "ناقل"])) {
    return "transmission";
  }

  if (hasAny(text, ["body shop", "سمكري", "حدادة سيارات", "صبغ", "دهان"])) {
    return "body_shop";
  }

  if (
    hasAny(text, [
      "auto parts",
      "car parts",
      "parts store",
      "tool store",
      "hardware store",
      "autozone",
      "o'reilly",
      "oreilly",
      "advance auto",
      "napa",
      "قطع غيار",
      "محل قطع",
      "محل أدوات",
      "ادوات",
      "أدوات",
      "price",
      "prices",
      "cost",
      "سعر",
      "اسعار",
      "تكلفة",
    ])
  ) {
    return "parts_tools";
  }

  if (
    hasAny(text, [
      "tow",
      "towing",
      "tow truck",
      "roadside",
      "سطحة",
      "سحب",
      "ونش",
    ])
  ) {
    return "towing";
  }

  if (
    hasAny(text, [
      "pre purchase",
      "pre-purchase",
      "inspection before buying",
      "used car inspection",
      "فحص قبل الشراء",
      "قبل لا اشتري",
      "اشتريها",
    ])
  ) {
    return "prepurchase";
  }

  return "auto_repair";
}

function buildPlacesBaseQuery(mode) {
  if (mode === "parts_tools") return "auto parts store OR tool store OR hardware store";
  if (mode === "tire") return "tire shop";
  if (mode === "brake_abs") return "ABS brake specialist OR brake repair";
  if (mode === "electrical") return "auto electrical specialist";
  if (mode === "transmission") return "transmission specialist";
  if (mode === "body_shop") return "auto body shop OR collision repair";
  if (mode === "towing") return "tow truck OR towing service";
  if (mode === "prepurchase") return "pre purchase inspection OR used car inspection";
  return "auto repair shop OR mechanic";
}

/* =========================================================
   PRICE HELPERS
========================================================= */
function mapPriceLevel(level) {
  const value = String(level || "").toUpperCase().trim();

  if (!value || value.includes("UNSPECIFIED")) {
    return { label: "", meaning_ar: "", meaning_en: "" };
  }

  if (value.includes("INEXPENSIVE")) {
    return { label: "$", meaning_ar: "اقتصادي", meaning_en: "Budget" };
  }

  if (value.includes("MODERATE")) {
    return { label: "$$", meaning_ar: "متوسط", meaning_en: "Moderate" };
  }

  if (value.includes("EXPENSIVE")) {
    return { label: "$$$", meaning_ar: "مرتفع", meaning_en: "Expensive" };
  }

  if (value.includes("VERY_EXPENSIVE")) {
    return { label: "$$$$", meaning_ar: "فاخر", meaning_en: "Very Expensive" };
  }

  return { label: "", meaning_ar: "", meaning_en: "" };
}

function priceHint({ mode, priceLevelLabel, locale }) {
  const isAr = String(locale || "en").toLowerCase().startsWith("ar");

  if (!priceLevelLabel) return "";

  if (mode === "parts_tools") {
    return isAr
      ? `تصنيف سعر المتجر: ${priceLevelLabel} (تقريبي حسب Google)`
      : `Store price tier: ${priceLevelLabel} (approx, Google)`;
  }

  return isAr
    ? `تصنيف التكلفة: ${priceLevelLabel} (تقريبي حسب Google)`
    : `Cost tier: ${priceLevelLabel} (approx, Google)`;
}

/* =========================================================
   CACHE
========================================================= */
function cacheGet(cacheMap, key) {
  const hit = cacheMap.get(key);
  if (!hit) return null;

  if (Date.now() > hit.expiry) {
    cacheMap.delete(key);
    return null;
  }

  return hit.value;
}

function cacheSet(cacheMap, key, value, ttlMs = CACHE_TTL_MS) {
  cacheMap.set(key, {
    value,
    expiry: Date.now() + ttlMs,
  });
}

/* =========================================================
   GEO NORMALIZATION (OPTIONAL FUTURE USE)
========================================================= */
async function geocodeTextLocation(locationText, locale = "en") {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey || !locationText) return null;

  const cacheKey = `geo::${normalizeLocale(locale)}::${locationText}`;
  const cached = cacheGet(GEO_CACHE, cacheKey);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);

  try {
    const fetchFn = await ensureFetch();
    const response = await fetchFn(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask":
            "places.location,places.formattedAddress,places.displayName",
        },
        body: JSON.stringify({
          textQuery: String(locationText),
          maxResultCount: 1,
          languageCode: normalizeLocale(locale),
        }),
      }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) return null;

    const place = Array.isArray(data?.places) ? data.places[0] : null;
    const location = place?.location;
    if (
      location &&
      Number.isFinite(Number(location.latitude)) &&
      Number.isFinite(Number(location.longitude))
    ) {
      const result = {
        lat: Number(location.latitude),
        lng: Number(location.longitude),
        formatted_address: place?.formattedAddress || "",
        display_name: place?.displayName?.text || "",
      };
      cacheSet(GEO_CACHE, cacheKey, result, CACHE_TTL_MS);
      return result;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   GOOGLE PLACES
========================================================= */
async function searchPlaces({ query, userLocation, locale, radiusMeters }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return [];

  const languageCode = normalizeLocale(locale);
  const mode = detectModeFromText(query);
  const baseQuery = buildPlacesBaseQuery(mode);

  let gps = parseLatLng(userLocation);
  let locationText = safeCityText(userLocation);

  if (!gps && !locationText) {
    const extracted = extractLocationFromQuery(query);
    if (parseLatLng(extracted)) {
      gps = parseLatLng(extracted);
    } else {
      locationText = extracted;
    }
  }

  const zip = extractZip(query);
  if (zip) locationText = zip;

  if (!gps && locationText && !parseLatLng(locationText)) {
    const geo = await geocodeTextLocation(locationText, locale);
    if (geo?.lat && geo?.lng) {
      gps = { lat: geo.lat, lng: geo.lng };
    }
  }

  if (!gps && !locationLooksUsable(locationText)) return [];

  const textQuery = gps
    ? baseQuery
    : `${baseQuery} in ${locationText}`;

  const radius = Number(radiusMeters || DEFAULT_RADIUS_METERS);

  const cacheKey = `${languageCode}::${textQuery}::${
    gps
      ? `${gps.lat.toFixed(3)},${gps.lng.toFixed(3)}:${radius}`
      : `anchor:${locationText}`
  }`;

  const cached = cacheGet(PLACES_CACHE, cacheKey);
  if (cached) return cached;

  const body = {
    textQuery,
    maxResultCount: clamp(PLACES_MAX_RESULTS, 1, 10),
    languageCode,
  };

  if (gps) {
    body.locationBias = {
      circle: {
        center: { latitude: gps.lat, longitude: gps.lng },
        radius,
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);

  try {
    const fetchFn = await ensureFetch();

    const response = await fetchFn(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": [
            "places.displayName",
            "places.formattedAddress",
            "places.googleMapsUri",
            "places.id",
            "places.rating",
            "places.userRatingCount",
            "places.nationalPhoneNumber",
            "places.websiteUri",
            "places.priceLevel",
            "places.businessStatus",
            "places.currentOpeningHours",
            "places.primaryTypeDisplayName",
          ].join(","),
        },
        body: JSON.stringify(body),
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("Places non-OK:", response.status, data?.error?.message || data);
      return [];
    }

    const places = Array.isArray(data?.places) ? data.places : [];

    const mapped = places.slice(0, PLACES_MAX_RESULTS).map((place) => {
      const priceLevel = place?.priceLevel ?? "";
      const price = mapPriceLevel(priceLevel);

      return {
        name: place?.displayName?.text || "",
        address: place?.formattedAddress || "",
        maps_url: place?.googleMapsUri || "",
        website: place?.websiteUri || "",
        place_id: place?.id || "",
        rating: place?.rating ?? null,
        ratings_total: place?.userRatingCount ?? null,
        phone: place?.nationalPhoneNumber || "",
        price_level: priceLevel || "",
        price_label: price.label,
        price_meaning_ar: price.meaning_ar,
        price_meaning_en: price.meaning_en,
        price_hint: priceHint({
          mode,
          priceLevelLabel: price.label,
          locale,
        }),
        business_status: place?.businessStatus || "",
        open_now:
          typeof place?.currentOpeningHours?.openNow === "boolean"
            ? place.currentOpeningHours.openNow
            : null,
        primary_type:
          place?.primaryTypeDisplayName?.text ||
          "",
        mode,
        location_anchor: gps
          ? "gps"
          : String(locationText || ""),
        source: "google_places_new",
      };
    });

    const deduped = uniqBy(
      mapped,
      (item) => item.place_id || item.maps_url || `${item.name}::${item.address}`
    );

    cacheSet(PLACES_CACHE, cacheKey, deduped);
    return deduped;
  } catch (error) {
    console.error("Places error:", error?.message || error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   DECISION LAYER
========================================================= */
function shouldSearchPlaces({
  allowPlaces = false,
  query = "",
  userLocation = null,
  forcePlaces = false,
}) {
  if (!allowPlaces && !forcePlaces) return false;

  const signals = buildSearchSignals(query);
  const extractedLocation = extractLocationFromQuery(query);
  const usableLocation =
    Boolean(parseLatLng(userLocation)) ||
    locationLooksUsable(safeCityText(userLocation)) ||
    locationLooksUsable(extractedLocation);

  if (forcePlaces) return true;

  if (!signals.hasPlacesWords) return false;

  if (signals.hasPlacesWords && usableLocation) return true;

  return signals.hasPlacesWords;
}

function deriveSearchMeta({
  query = "",
  verified_data = [],
  verified_workshops = [],
  verified_actions = [],
}) {
  const signals = buildSearchSignals(query);

  return {
    query_script: signals.script,
    detected_fault_codes: signals.codes,
    used_internal_kb: Array.isArray(verified_data) && verified_data.length > 0,
    used_places: Array.isArray(verified_workshops) && verified_workshops.length > 0,
    used_failure_actions: Array.isArray(verified_actions) && verified_actions.length > 0,
    diagnosis_signal: signals.hasDiagnosisWords,
    places_signal: signals.hasPlacesWords,
    purchase_signal: signals.hasPurchaseWords,
    safety_signal: signals.hasSafetyWords,
  };
}

/* =========================================================
   MAIN EXPORT
========================================================= */
export async function performSearch(userQuery, userLocation, opts = {}) {
  const {
    locale = "en",
    allowPlaces = false,
    maxResults = DEFAULT_KB_RESULTS,
    placesRadiusMeters,
    forcePlaces = false,
    skipInternalKb = false,
  } = opts;

  const query = String(userQuery || "").trim();

  const verified_data =
    !skipInternalKb && query.length >= 2
      ? searchLocalKB(query, maxResults)
      : [];

  const verified_actions =
    query.length >= 2
      ? matchFailureActions(query, DEFAULT_ACTION_RESULTS)
      : [];

  let verified_workshops = [];

  if (
    shouldSearchPlaces({
      allowPlaces,
      query,
      userLocation,
      forcePlaces,
    })
  ) {
    verified_workshops = await searchPlaces({
      query,
      userLocation,
      locale,
      radiusMeters: placesRadiusMeters,
    });
  }

  return {
    verified_data,
    verified_actions,
    verified_workshops,
    search_meta: deriveSearchMeta({
      query,
      verified_data,
      verified_actions,
      verified_workshops,
    }),
  };
}
