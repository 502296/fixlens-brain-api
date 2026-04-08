// engineIntel.js
// FixLens Engine Intel v2.0

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupe(items = []) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = normalizeText(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function extractYear(text = "") {
  const match = String(text || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function containsAny(text = "", list = []) {
  const t = normalizeText(text);
  return list.some((item) => t.includes(normalizeText(item)));
}

function extractFaultCodes(text = "") {
  const matches = String(text || "").match(/\b([PCUB][0-9]{3,4}|[A-Z][0-9]{4})\b/gi);
  return dedupe((matches || []).map((x) => x.toUpperCase()));
}

const MAKE_MODEL_MAP = [
  {
    make: "Toyota",
    makeAliases: ["toyota", "تويوتا"],
    models: [
      { model: "Camry", aliases: ["camry", "كامري"] },
      { model: "Corolla", aliases: ["corolla", "كورولا"] },
      { model: "RAV4", aliases: ["rav4", "rav 4", "راف فور"] },
      { model: "Highlander", aliases: ["highlander", "هايلاندر"] },
      { model: "Avalon", aliases: ["avalon", "افالون"] },
      { model: "Prius", aliases: ["prius", "بريوس"] },
      { model: "Land Cruiser", aliases: ["land cruiser", "لاندكروزر", "لاند كروزر"] },
      { model: "Tacoma", aliases: ["tacoma", "تاكوما"] },
      { model: "Tundra", aliases: ["tundra", "تندرا"] },
      { model: "4Runner", aliases: ["4runner", "4 runner", "فور رنر"] },
    ],
  },
  {
    make: "Honda",
    makeAliases: ["honda", "هوندا"],
    models: [
      { model: "Civic", aliases: ["civic", "سيفك", "سيفيك"] },
      { model: "Accord", aliases: ["accord", "اكورد", "أكورد"] },
      { model: "CR-V", aliases: ["crv", "cr-v", "سي ار في"] },
      { model: "Pilot", aliases: ["pilot", "بايلوت"] },
      { model: "Odyssey", aliases: ["odyssey", "اوديسي"] },
    ],
  },
  {
    make: "Nissan",
    makeAliases: ["nissan", "نيسان"],
    models: [
      { model: "Altima", aliases: ["altima", "التيما"] },
      { model: "Maxima", aliases: ["maxima", "ماكسيما"] },
      { model: "Sentra", aliases: ["sentra", "سنترا"] },
      { model: "Rogue", aliases: ["rogue", "روغ", "روك"] },
      { model: "Pathfinder", aliases: ["pathfinder", "باثفايندر"] },
    ],
  },
  {
    make: "Ford",
    makeAliases: ["ford", "فورد"],
    models: [
      { model: "F-150", aliases: ["f150", "f-150", "اف 150"] },
      { model: "Explorer", aliases: ["explorer", "اكسبلورر"] },
      { model: "Escape", aliases: ["escape", "اسكيب"] },
      { model: "Fusion", aliases: ["fusion", "فيوجن"] },
      { model: "Focus", aliases: ["focus", "فوكس"] },
      { model: "Mustang", aliases: ["mustang", "موستنغ"] },
    ],
  },
  {
    make: "Chevrolet",
    makeAliases: ["chevrolet", "chevy", "شفر", "شيفروليه", "شفروليه"],
    models: [
      { model: "Silverado", aliases: ["silverado", "سيلفرادو"] },
      { model: "Tahoe", aliases: ["tahoe", "تاهو"] },
      { model: "Suburban", aliases: ["suburban", "سوبربان"] },
      { model: "Malibu", aliases: ["malibu", "ماليبو"] },
      { model: "Impala", aliases: ["impala", "امبالا"] },
      { model: "Cruze", aliases: ["cruze", "كروز"] },
    ],
  },
  {
    make: "BMW",
    makeAliases: ["bmw", "بي ام دبليو", "بي ام"],
    models: [
      { model: "3 Series", aliases: ["320i", "328i", "330i", "335i", "3 series"] },
      { model: "5 Series", aliases: ["520i", "528i", "530i", "535i", "5 series"] },
      { model: "X5", aliases: ["x5"] },
      { model: "X3", aliases: ["x3"] },
    ],
  },
  {
    make: "Mercedes-Benz",
    makeAliases: ["mercedes", "mercedes-benz", "benz", "مرسيدس", "بنز"],
    models: [
      { model: "C-Class", aliases: ["c300", "c250", "c350", "c class", "c-class"] },
      { model: "E-Class", aliases: ["e350", "e300", "e class", "e-class"] },
      { model: "S-Class", aliases: ["s550", "s500", "s class", "s-class"] },
      { model: "ML / GLE", aliases: ["ml350", "gle350", "ml", "gle"] },
    ],
  },
  {
    make: "Lexus",
    makeAliases: ["lexus", "لكزس", "لكسس"],
    models: [
      { model: "ES", aliases: ["es350", "es 350", "es"] },
      { model: "RX", aliases: ["rx350", "rx 350", "rx"] },
      { model: "GX", aliases: ["gx460", "gx 460", "gx"] },
      { model: "LX", aliases: ["lx570", "lx 570", "lx"] },
      { model: "IS", aliases: ["is250", "is 250", "is350", "is 350", "is"] },
    ],
  },
];

const ENGINE_HINTS = [
  {
    label: "2.4L 4-cylinder",
    aliases: ["2.4", "2.4l", "2.4 liter", "2.4 litre"],
  },
  {
    label: "2.5L 4-cylinder",
    aliases: ["2.5", "2.5l", "2.5 liter", "2.5 litre"],
  },
  {
    label: "2.0L turbo",
    aliases: ["2.0 turbo", "2.0t", "2.0 l turbo"],
  },
  {
    label: "3.5L V6",
    aliases: ["3.5", "3.5l", "3.5 v6", "v6 3.5"],
  },
  {
    label: "4.0L V6",
    aliases: ["4.0", "4.0l", "4.0 v6", "v6 4.0"],
  },
  {
    label: "4.6L V8",
    aliases: ["4.6", "4.6l", "4.6 v8", "v8 4.6"],
  },
  {
    label: "5.7L V8",
    aliases: ["5.7", "5.7l", "5.7 v8", "v8 5.7"],
  },
];

const SIMPLE_PATTERNS = [
  {
    label: "ignition misfire from coil, plug, injector, or air leak path",
    score: 8,
    keywords: [
      "misfire",
      "rough idle",
      "hesitation",
      "shaking",
      "shake",
      "check engine",
      "engine shaking",
      "تفتفة",
      "اهتزاز",
      "نتعة",
      "يرجف",
    ],
    codes: ["P03"],
    domain: "engine",
  },
  {
    label: "cooling system pressure loss, thermostat path, or circulation weakness",
    score: 8,
    keywords: [
      "overheating",
      "running hot",
      "coolant",
      "temperature high",
      "heat",
      "حرارة",
      "نقص ماء",
      "ماء الرديتر",
    ],
    codes: ["P0128", "P0217", "P0117", "P0118"],
    domain: "cooling",
  },
  {
    label: "charging-system weakness from alternator, battery, or cable connection",
    score: 7,
    keywords: [
      "battery",
      "alternator",
      "voltage",
      "charging",
      "battery light",
      "بطارية",
      "دينمو",
      "شحن",
    ],
    codes: ["P0560", "P0562", "P0620"],
    domain: "electrical",
  },
  {
    label: "ABS / brake control subsystem fault cluster",
    score: 9,
    keywords: [
      "abs",
      "brake",
      "traction",
      "stability",
      "esp",
      "فرامل",
      "مانع الانغلاق",
      "abs light",
    ],
    codes: ["C12", "C13"],
    domain: "brakes",
  },
  {
    label: "air suspension / ride height / compressor fault path",
    score: 7,
    keywords: [
      "air suspension",
      "ride height",
      "suspension",
      "تعليق",
      "هيدروليك",
      "كمبرسر",
      "compressor",
      "height sensor",
    ],
    codes: ["C17", "C18"],
    domain: "suspension",
  },
  {
    label: "communication / control module / shared voltage issue",
    score: 7,
    keywords: [
      "communication",
      "network",
      "module",
      "can bus",
      "gateway",
      "وحدة تحكم",
      "شبكة",
    ],
    codes: ["U0", "U1"],
    domain: "electrical",
  },
];

function detectMakeAndModel(text = "") {
  const t = normalizeText(text);
  let make = null;
  let model = null;

  for (const makeDef of MAKE_MODEL_MAP) {
    const makeMatched = containsAny(t, makeDef.makeAliases || []);
    const modelMatched = (makeDef.models || []).find((m) =>
      containsAny(t, m.aliases || [])
    );

    if (makeMatched) {
      make = makeDef.make;
      if (modelMatched) model = modelMatched.model;
      break;
    }

    if (!make && modelMatched) {
      make = makeDef.make;
      model = modelMatched.model;
      break;
    }
  }

  return { make, model };
}

function detectEngineHint(text = "") {
  const t = normalizeText(text);

  for (const item of ENGINE_HINTS) {
    if (containsAny(t, item.aliases || [])) {
      return item.label;
    }
  }

  return null;
}

function matchSimplePatterns(text = "", codes = []) {
  const t = normalizeText(text);
  const upperCodes = (codes || []).map((x) => String(x || "").toUpperCase());
  const matches = [];

  for (const pattern of SIMPLE_PATTERNS) {
    let score = 0;
    const matchedKeywords = [];
    const matchedCodes = [];

    for (const keyword of pattern.keywords || []) {
      if (t.includes(normalizeText(keyword))) {
        score += 2;
        matchedKeywords.push(keyword);
      }
    }

    for (const prefix of pattern.codes || []) {
      if (upperCodes.some((c) => c.startsWith(prefix))) {
        score += 4;
        matchedCodes.push(prefix);
      }
    }

    if (score > 0) {
      matches.push({
        label: pattern.label,
        score: pattern.score + score,
        why: [
          matchedKeywords.length ? `matched keywords: ${matchedKeywords.join(", ")}` : "",
          matchedCodes.length ? `matched code prefixes: ${matchedCodes.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" | "),
        domain: pattern.domain || "general",
      });
    }
  }

  return matches
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 6);
}

function buildIntelBestPattern({
  make = null,
  model = null,
  year = null,
  detectedEngine = null,
  simpleMatches = [],
  codes = [],
  text = "",
}) {
  const t = normalizeText(text);
  const upperCodes = (codes || []).map((x) => String(x || "").toUpperCase());

  const specialRules = [];

  const pushRule = (label, score, why) => {
    specialRules.push({ label, score, why });
  };

  if (
    upperCodes.some((c) => c.startsWith("C12") || c.startsWith("C13")) &&
    (t.includes("abs") || t.includes("brake") || t.includes("traction") || t.includes("stability") || upperCodes.length >= 2)
  ) {
    pushRule(
      "clustered ABS / brake-control issue with likely shared root cause",
      12,
      "related chassis codes suggest one central subsystem fault more than separate independent failures"
    );
  }

  if (
    upperCodes.some((c) => c.startsWith("P03")) &&
    (t.includes("rough idle") || t.includes("misfire") || t.includes("hesitation"))
  ) {
    pushRule(
      "active combustion / misfire pattern that needs ignition-air-fuel narrowing",
      11,
      "codes and symptoms align with real misfire behavior"
    );
  }

  if (
    t.includes("overheating") ||
    t.includes("حرارة") ||
    t.includes("coolant")
  ) {
    pushRule(
      "cooling-system fault path with pressure / flow / thermostat / fan possibilities",
      10,
      "heat-related wording strongly points to cooling-system diagnosis"
    );
  }

  if (
    make === "Toyota" &&
    model === "Camry" &&
    year &&
    year >= 2007 &&
    year <= 2017 &&
    (t.includes("rough idle") || upperCodes.some((c) => c.startsWith("P03")))
  ) {
    pushRule(
      "Toyota Camry misfire path that should first separate coil / plug / injector / intake leak before deeper conclusions",
      10,
      "vehicle context improves the misfire path"
    );
  }

  if (
    make === "Mercedes-Benz" &&
    (t.includes("air suspension") ||
      t.includes("ride height") ||
      upperCodes.some((c) => c.startsWith("C17") || c.startsWith("C18")))
  ) {
    pushRule(
      "Mercedes height-control / air-suspension path may center on compressor, valve block, leak, or height-sensor logic",
      10,
      "vehicle family plus suspension clues improve the fit"
    );
  }

  if (
    make === "BMW" &&
    (t.includes("battery") ||
      t.includes("voltage") ||
      upperCodes.some((c) => c.startsWith("U0") || c.startsWith("U1")))
  ) {
    pushRule(
      "BMW electrical instability may be cascading into multiple control-side complaints",
      9,
      "BMW platform plus voltage / communication clues strengthen electrical-root-cause logic"
    );
  }

  const all = [...specialRules, ...simpleMatches]
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  return all[0] || null;
}

function estimatePrepurchaseRisk({ codes = [], simpleMatches = [], text = "" }) {
  const t = normalizeText(text);
  const count = (codes || []).length;

  if (
    count >= 4 ||
    (codes || []).some((c) => c.startsWith("C12") || c.startsWith("C13")) ||
    t.includes("should i buy") ||
    t.includes("worth buying") ||
    t.includes("اشتريها")
  ) {
    return "elevated";
  }

  if ((simpleMatches || []).length >= 2) {
    return "moderate";
  }

  return "low";
}

export function buildEnginePack(text = "") {
  const rawText = String(text || "");
  const t = normalizeText(rawText);

  const year = extractYear(t);
  const { make, model } = detectMakeAndModel(t);
  const detectedEngine = detectEngineHint(t);
  const faultCodes = extractFaultCodes(rawText);
  const simpleMatches = matchSimplePatterns(t, faultCodes);
  const intelBestPattern = buildIntelBestPattern({
    make,
    model,
    year,
    detectedEngine,
    simpleMatches,
    codes: faultCodes,
    text: t,
  });

  const intelScore = Math.max(
    0,
    (make ? 2 : 0) +
      (model ? 2 : 0) +
      (year ? 1 : 0) +
      (detectedEngine ? 2 : 0) +
      Math.min(6, simpleMatches.length * 2) +
      (intelBestPattern ? 4 : 0) +
      Math.min(4, faultCodes.length)
  );

  return {
    make,
    model,
    year,

    detected_engine: detectedEngine,

    detected_fault_codes: faultCodes,

    simple_engine_issue_matches: simpleMatches,

    intel_best_pattern: intelBestPattern,

    prepurchase_risk: estimatePrepurchaseRisk({
      codes: faultCodes,
      simpleMatches,
      text: t,
    }),

    vehicle_identity: [year, make, model, detectedEngine]
      .filter(Boolean)
      .join(" ")
      .trim() || null,

    intel_score: intelScore,
  };
}
