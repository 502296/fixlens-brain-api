// responsePlanner.js
// FixLens Response Planner v1.0
// Purpose:
// - Turn raw case context into a structured diagnostic plan
// - Make replies stronger, less generic, more mechanic-like
// - Rank likely causes and next steps before final writing

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isArabic(locale = "") {
  return String(locale || "").toLowerCase().startsWith("ar");
}

function dedupe(items = []) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const value = String(item || "").trim();
    if (!value) continue;

    const key = normalizeToken(value);
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(value);
  }

  return out;
}

function lowerJoined(list = []) {
  return (Array.isArray(list) ? list : []).join(" | ").toLowerCase();
}

function rankLikelyCauses({
  memorySummary = {},
  enginePack = {},
  text = "",
  verifiedData = [],
}) {
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);
  const inputText = String(text || "").toLowerCase();
  const combined = `${symptomsText} | ${inputText}`;

  const causes = [];

  const pushCause = (label, score, why) => {
    causes.push({ label, score, why });
  };

  if (
    combined.includes("misfire") ||
    combined.includes("rough idle") ||
    combined.includes("hesitation") ||
    combined.includes("check engine")
  ) {
    pushCause(
      "ignition misfire from coil, plug, or related ignition weakness",
      9,
      "rough idle / misfire / hesitation pattern"
    );

    pushCause(
      "vacuum leak or unmetered air issue",
      7,
      "idle-related shake with air-fuel behavior"
    );

    pushCause(
      "fuel delivery imbalance such as injector issue",
      6,
      "misfire-like behavior without enough proof for pure ignition only"
    );
  }

  if (
    combined.includes("overheating") ||
    combined.includes("coolant") ||
    combined.includes("running hot") ||
    combined.includes("نقص ماء") ||
    combined.includes("حرارة")
  ) {
    pushCause(
      "cooling system pressure loss or coolant circulation problem",
      9,
      "temperature and coolant behavior"
    );

    pushCause(
      "thermostat, air pocket, or weak water pump path",
      7,
      "common cooling-system pattern"
    );
  }

  if (
    combined.includes("knock") ||
    combined.includes("خبط") ||
    combined.includes("دق")
  ) {
    pushCause(
      "true engine knock or heavy mechanical knock",
      8,
      "deep knock wording"
    );

    pushCause(
      "spark knock / detonation under load",
      6,
      "knock-related wording without confirmed internal damage"
    );
  }

  if (
    combined.includes("tick") ||
    combined.includes("ticking") ||
    combined.includes("طقطقة") ||
    combined.includes("تك تك")
  ) {
    pushCause(
      "top-end ticking, injector tick, or valvetrain-side noise",
      8,
      "light repetitive ticking pattern"
    );
  }

  if (
    combined.includes("squeal") ||
    combined.includes("صرير")
  ) {
    pushCause(
      "belt, pulley, or bearing noise",
      8,
      "squeal pattern"
    );
  }

  if (
    combined.includes("battery") ||
    combined.includes("alternator") ||
    combined.includes("دينمو") ||
    combined.includes("بطارية")
  ) {
    pushCause(
      "charging-system weakness from battery, alternator, or connection issue",
      8,
      "charging-related wording"
    );
  }

  if (
    Array.isArray(enginePack?.simple_engine_issue_matches) &&
    enginePack.simple_engine_issue_matches.length > 0
  ) {
    for (const item of enginePack.simple_engine_issue_matches.slice(0, 3)) {
      if (!item?.label) continue;
      pushCause(
        String(item.label),
        7,
        "matched internal engine issue pattern"
      );
    }
  }

  if (enginePack?.intel_best_pattern?.label) {
    pushCause(
      String(enginePack.intel_best_pattern.label),
      8,
      "matched structured engine intel"
    );
  }

  if (Array.isArray(verifiedData) && verifiedData.length > 0) {
    pushCause(
      "verified external data supports narrowing the diagnosis",
      4,
      "search-supported refinement"
    );
  }

  return causes
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter((item, index, arr) => {
      const key = normalizeToken(item.label);
      return arr.findIndex((x) => normalizeToken(x.label) === key) === index;
    })
    .slice(0, 4);
}

function buildTests({
  memorySummary = {},
  topCause = "",
}) {
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);
  const repairs = lowerJoined(memorySummary?.prior_repairs || []);
  const tests = [];

  const pushTest = (value) => {
    if (value) tests.push(value);
  };

  if (
    topCause.includes("ignition") ||
    symptomsText.includes("misfire") ||
    symptomsText.includes("rough idle")
  ) {
    pushTest("scan fault codes if available");
    pushTest("inspect ignition coils and spark plugs first");
    pushTest("check for intake or vacuum leak around hoses and manifold");
    pushTest("listen for idle change if a vacuum leak is present");
  }

  if (
    topCause.includes("cooling") ||
    symptomsText.includes("overheating") ||
    symptomsText.includes("coolant")
  ) {
    pushTest("check coolant level cold and inspect for pressure loss");
    pushTest("look for visible leak, dried coolant marks, or trapped air");
    pushTest("confirm radiator fan behavior and thermostat path");
  }

  if (
    topCause.includes("knock")
  ) {
    pushTest("do not keep driving hard until the knock direction is clearer");
    pushTest("check oil level and warning lights immediately");
    pushTest("compare whether the sound is light tick or deep load-sensitive knock");
  }

  if (
    topCause.includes("belt") ||
    topCause.includes("pulley") ||
    topCause.includes("bearing")
  ) {
    pushTest("inspect belt condition and pulley alignment");
    pushTest("listen at the belt path and accessory side");
  }

  if (
    topCause.includes("charging-system") ||
    symptomsText.includes("battery issue") ||
    symptomsText.includes("alternator issue")
  ) {
    pushTest("test battery voltage with engine off and running");
    pushTest("inspect terminals and ground connection");
    pushTest("check alternator output under load");
  }

  if (repairs.includes("spark plugs") && topCause.includes("ignition")) {
    pushTest("since plugs were already replaced, focus more on coils, install quality, and related air leak path");
  }

  return dedupe(tests).slice(0, 5);
}

function buildQuestions({
  memorySummary = {},
  topCause = "",
}) {
  const questions = [];
  const codes = Array.isArray(memorySummary?.fault_codes)
    ? memorySummary.fault_codes
    : [];

  const unresolved = lowerJoined(memorySummary?.unresolved_points || []);
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);

  const pushQuestion = (q) => {
    if (q) questions.push(q);
  };

  if (codes.length === 0 && topCause.includes("ignition")) {
    pushQuestion("Are there any check-engine codes right now, or is the light just on without a scan?");
  }

  if (
    symptomsText.includes("rough idle") ||
    symptomsText.includes("misfire")
  ) {
    pushQuestion("Is the shake strongest at idle and does it smooth out when you give it throttle?");
  }

  if (
    topCause.includes("knock")
  ) {
    pushQuestion("Is the sound a light fast tick, or a deeper knock that gets heavier under load?");
  }

  if (
    topCause.includes("cooling")
  ) {
    pushQuestion("Does the temperature rise mainly while driving, at idle, or both?");
  }

  if (
    unresolved.includes("fault_codes_unknown")
  ) {
    pushQuestion("If you do not have a scanner yet, tell me whether the check-engine light is steady or flashing.");
  }

  return dedupe(questions).slice(0, 2);
}

function detectSeverity({
  memorySummary = {},
  topCause = "",
  text = "",
}) {
  const combined = `${lowerJoined(memorySummary?.symptoms || [])} | ${String(text || "").toLowerCase()}`;

  if (
    combined.includes("brake") ||
    combined.includes("steering failure") ||
    combined.includes("oil pressure") ||
    combined.includes("burning smell") ||
    combined.includes("fuel leak") ||
    combined.includes("severe overheating") ||
    topCause.includes("true engine knock")
  ) {
    return "urgent";
  }

  if (
    combined.includes("overheating") ||
    combined.includes("misfire") ||
    combined.includes("stall") ||
    combined.includes("knock")
  ) {
    return "high";
  }

  if (
    combined.includes("rough idle") ||
    combined.includes("hesitation") ||
    combined.includes("battery") ||
    combined.includes("alternator")
  ) {
    return "medium";
  }

  return "low";
}

function detectDomain(topCause = "", text = "") {
  const value = `${String(topCause || "").toLowerCase()} | ${String(text || "").toLowerCase()}`;

  if (
    value.includes("ignition") ||
    value.includes("misfire") ||
    value.includes("vacuum") ||
    value.includes("injector") ||
    value.includes("knock") ||
    value.includes("tick")
  ) return "engine";

  if (
    value.includes("cooling") ||
    value.includes("coolant") ||
    value.includes("thermostat")
  ) return "cooling";

  if (
    value.includes("battery") ||
    value.includes("alternator") ||
    value.includes("charging")
  ) return "electrical";

  if (
    value.includes("brake")
  ) return "brakes";

  if (
    value.includes("steering")
  ) return "steering";

  return "general";
}

function shouldUseSearch({
  placesIntent = false,
  verifiedData = [],
  verifiedWorkshops = [],
  internalIntelStrong = false,
}) {
  if (placesIntent) return true;
  if (Array.isArray(verifiedWorkshops) && verifiedWorkshops.length > 0) return true;
  if (Array.isArray(verifiedData) && verifiedData.length > 0) return false;
  if (internalIntelStrong) return false;
  return false;
}

function buildSearchQuery({
  topCause = "",
  memorySummary = {},
  text = "",
  locale = "en",
}) {
  const vehicle = memorySummary?.vehicle || {};
  const vehicleText = [vehicle?.year, vehicle?.make, vehicle?.model]
    .filter(Boolean)
    .join(" ");

  const symptomLead = Array.isArray(memorySummary?.symptoms)
    ? memorySummary.symptoms.slice(0, 2).join(" ")
    : "";

  const q = [vehicleText, topCause, symptomLead, text]
    .filter(Boolean)
    .join(" ")
    .trim();

  return q.slice(0, 220);
}

export function buildResponsePlan({
  locale = "en",
  text = "",
  placesIntent = false,
  enginePack = {},
  diagnosticMemory = {},
  verifiedData = [],
  verifiedWorkshops = [],
  internalIntelStrong = false,
}) {
  const memorySummary = diagnosticMemory?.current_case_summary || {};
  const ranked = rankLikelyCauses({
    memorySummary,
    enginePack,
    text,
    verifiedData,
  });

  const topCause = ranked[0]?.label || "general mechanical fault path still needs narrowing";
  const severity = detectSeverity({
    memorySummary,
    topCause,
    text,
  });

  const domain = detectDomain(topCause, text);
  const tests = buildTests({
    memorySummary,
    topCause,
  });

  const questions = buildQuestions({
    memorySummary,
    topCause,
  });

  const needsSearch = shouldUseSearch({
    placesIntent,
    verifiedData,
    verifiedWorkshops,
    internalIntelStrong,
  });

  const query = needsSearch
    ? buildSearchQuery({
        topCause,
        memorySummary,
        text,
        locale,
      })
    : "";

  return {
    severity,
    domain,
    strongest_hypothesis: topCause,
    likely_causes: ranked.map((item) => item.label).slice(0, 4),
    likely_cause_reasons: ranked.map((item) => item.why).slice(0, 4),
    tests,
    must_ask: questions,
    needs_search: needsSearch,
    query,
    planner_text: buildPlannerText({
      locale,
      severity,
      domain,
      topCause,
      ranked,
      tests,
      questions,
      memorySummary,
    }),
  };
}

export function buildPlannerText({
  locale = "en",
  severity = "medium",
  domain = "general",
  topCause = "",
  ranked = [],
  tests = [],
  questions = [],
  memorySummary = {},
}) {
  return `
RESPONSE_PLANNER:
SEVERITY=${JSON.stringify(severity)}
DOMAIN=${JSON.stringify(domain)}
STRONGEST_HYPOTHESIS=${JSON.stringify(topCause)}
LIKELY_CAUSES=${JSON.stringify((ranked || []).map((x) => x.label))}
LIKELY_CAUSE_REASONS=${JSON.stringify((ranked || []).map((x) => x.why))}
RECOMMENDED_TESTS=${JSON.stringify(tests || [])}
MUST_ASK=${JSON.stringify(questions || [])}
MEMORY_SUMMARY=${JSON.stringify(memorySummary || {})}

PLANNER_RULES:
- Lead with STRONGEST_HYPOTHESIS first.
- Do not present all causes as equal.
- Use RECOMMENDED_TESTS to guide the next practical step.
- Use MUST_ASK only if those questions materially improve the next move.
- Sound like a real diagnostician, not a generic assistant.
- Prefer the shortest and highest-yield path first.
`.trim();
}
