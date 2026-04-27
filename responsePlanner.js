// responsePlanner.js
// FixLens Response Planner v4.1
// Doctor Brain Planner — calm, premium, probabilistic, user-facing
// Smart Question Engine — asks only when the question truly changes the next step

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function friendlyLabel(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  return raw
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\babs\b/gi, "ABS")
    .replace(/\bmaf\b/gi, "MAF")
    .replace(/\bmap\b/gi, "MAP")
    .replace(/\bengine-side\b/gi, "engine-side")
    .trim();
}

function calmCauseLabel(value = "") {
  const label = friendlyLabel(value);
  if (!label) return "";

  return label
    .replace(/^most likely cause[:\s-]*/i, "")
    .replace(/^true /i, "")
    .replace(/\bweakness\b/gi, "weakness")
    .trim();
}

function uniqueCodesFromMemory(memorySummary = {}, text = "") {
  const rawCodes = [];

  if (Array.isArray(memorySummary?.fault_codes)) rawCodes.push(...memorySummary.fault_codes);
  if (Array.isArray(memorySummary?.codes)) rawCodes.push(...memorySummary.codes);

  const textMatches = String(text || "").match(/\b([PCUB][0-9]{4}|[A-Z][0-9]{4})\b/gi);
  if (textMatches?.length) rawCodes.push(...textMatches);

  return dedupe(rawCodes.map((x) => String(x || "").toUpperCase()));
}

function detectUserIntent(text = "", memorySummary = {}) {
  const combined = `${String(text || "").toLowerCase()} | ${lowerJoined(
    memorySummary?.symptoms || []
  )} | ${lowerJoined(memorySummary?.unresolved_points || [])}`;

  return {
    purchaseIntent:
      combined.includes("buy this car") ||
      combined.includes("worth buying") ||
      combined.includes("should i buy") ||
      combined.includes("before i buy") ||
      combined.includes("pre purchase") ||
      combined.includes("pre-purchase") ||
      combined.includes("inspection before buying"),

    safetyIntent:
      combined.includes("safe to drive") ||
      combined.includes("can i drive") ||
      combined.includes("is it safe") ||
      combined.includes("should i keep driving") ||
      combined.includes("drive it like this"),

    priceRiskIntent:
      combined.includes("expensive") ||
      combined.includes("costly") ||
      combined.includes("repair cost") ||
      combined.includes("big repair") ||
      combined.includes("how much") ||
      combined.includes("worth fixing"),
  };
}

function classifyCodeClusters(codes = [], text = "", memorySummary = {}) {
  const upperCodes = safeArray(codes).map((x) => String(x || "").toUpperCase());
  const combined = `${upperCodes.join(" | ")} | ${String(text || "").toLowerCase()} | ${lowerJoined(
    memorySummary?.symptoms || []
  )}`;

  const clusters = [];
  const addCluster = (key, score, reason) => clusters.push({ key, score, reason });

  const hasCodePrefix = (prefixes = []) =>
    upperCodes.some((c) => prefixes.some((p) => c.startsWith(p)));

  if (
    hasCodePrefix(["C12", "C13"]) ||
    combined.includes("abs") ||
    combined.includes("brake") ||
    combined.includes("stability") ||
    combined.includes("traction")
  ) {
    addCluster("abs_brake_stability", 10, "brake or ABS clues point to one shared control path");
  }

  if (
    hasCodePrefix(["P03"]) ||
    combined.includes("misfire") ||
    combined.includes("rough idle") ||
    combined.includes("hesitation") ||
    combined.includes("shake") ||
    combined.includes("shakes") ||
    combined.includes("check engine")
  ) {
    addCluster("misfire_combustion", 9, "idle shake, warning light, or hesitation fits a combustion issue");
  }

  if (
    hasCodePrefix(["P01", "P02"]) ||
    combined.includes("fuel trim") ||
    combined.includes("vacuum") ||
    combined.includes("lean") ||
    combined.includes("rich")
  ) {
    addCluster("air_fuel_metering", 8, "air-fuel clues suggest airflow or fueling imbalance");
  }

  if (
    combined.includes("coolant") ||
    combined.includes("overheating") ||
    combined.includes("running hot")
  ) {
    addCluster("cooling_system", 9, "temperature behavior points toward cooling-system logic");
  }

  if (
    combined.includes("battery") ||
    combined.includes("alternator") ||
    combined.includes("voltage") ||
    combined.includes("charging")
  ) {
    addCluster("charging_voltage", 8, "voltage behavior can create shared electrical symptoms");
  }

  if (
    combined.includes("air suspension") ||
    combined.includes("ride height") ||
    combined.includes("suspension") ||
    upperCodes.some((c) => c.startsWith("C17") || c.startsWith("C18"))
  ) {
    addCluster("suspension_height_control", 7, "ride-height behavior may belong to one suspension path");
  }

  if (
    combined.includes("communication") ||
    combined.includes("network") ||
    upperCodes.some((c) => c.startsWith("U0") || c.startsWith("U1"))
  ) {
    addCluster("network_communication", 8, "network faults often come from shared power, wiring, or module issues");
  }

  return clusters
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter((item, index, arr) => {
      const key = normalizeToken(item.key);
      return arr.findIndex((x) => normalizeToken(x.key) === key) === index;
    });
}

function getClusterHypotheses(clusterKey = "", codes = [], combinedText = "") {
  const text = String(combinedText || "").toLowerCase();
  const upperCodes = safeArray(codes).map((x) => String(x || "").toUpperCase());
  const out = [];
  const push = (label, score, why) => out.push({ label, score, why });

  if (clusterKey === "abs_brake_stability") {
    push("ABS or brake control fault path", 10, "related brake-control clues can share one root cause");
    push("ABS actuator, hydraulic unit, or module-side issue", 9, "multiple brake-control clues may fit the central ABS side");
    push("shared wiring, connector, ground, or power issue", 8, "one shared electrical path can trigger several chassis faults");

    if (upperCodes.includes("C1252") || upperCodes.includes("C1256")) {
      push("hydraulic or actuator-side ABS issue", 9, "those codes strengthen the actuator or hydraulic path");
    }

    if (upperCodes.includes("C1210")) {
      push("stability control reacting to a deeper ABS-side fault", 7, "that code can fit into a wider brake-control chain");
    }
  }

  if (clusterKey === "misfire_combustion") {
    push("ignition-side misfire", 9, "idle shake and weak acceleration often start with plugs, coils, or ignition signal");
    push("small vacuum leak or unmetered air issue", 8, "idle-sensitive shaking can come from extra air entering the intake");
    push("fuel injector or fuel-delivery imbalance", 7, "fuel-side imbalance can mimic an ignition problem");

    if (text.includes("flashing")) {
      push("active misfire with catalyst-risk pattern", 10, "a flashing check-engine light raises urgency");
    }
  }

  if (clusterKey === "air_fuel_metering") {
    push("vacuum leak or intake leak", 9, "air-fuel imbalance often starts with unmetered air");
    push("MAF or MAP measurement issue", 7, "bad airflow readings can distort fueling");
    push("fuel-pressure or injector imbalance", 7, "fuel-side problems remain realistic");
  }

  if (clusterKey === "cooling_system") {
    push("cooling-system pressure loss or circulation issue", 9, "heat behavior fits cooling-system logic first");
    push("thermostat, trapped air, or weak water-pump path", 8, "that is a common cooling branch");
    push("radiator fan control issue", 7, "idle-heavy overheating shifts suspicion toward fan behavior");
  }

  if (clusterKey === "charging_voltage") {
    push("battery, alternator, or charging connection weakness", 9, "voltage-related symptoms often start there");
    push("ground or terminal issue", 8, "one poor connection can create unstable electrical behavior");
  }

  if (clusterKey === "suspension_height_control") {
    push("air-suspension compressor, valve block, or height-control issue", 8, "ride-height behavior often points to one central path");
    push("height sensor or related wiring issue", 7, "sensor-side fault remains possible");
    push("air leak in a bag, line, or circuit", 8, "air loss is a common reason for height drop");
  }

  if (clusterKey === "network_communication") {
    push("module communication issue from voltage, wiring, or one control unit", 8, "network faults usually come from a shared root cause");
    push("battery or charging instability creating misleading communication faults", 7, "low voltage can cascade into network errors");
  }

  return out;
}

function rankLikelyCauses({
  memorySummary = {},
  enginePack = {},
  diagnosticEngine = {},
  text = "",
  verifiedData = [],
}) {
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);
  const inputText = String(text || "").toLowerCase();
  const combined = `${symptomsText} | ${inputText}`;
  const codes = uniqueCodesFromMemory(memorySummary, text);
  const clusters = classifyCodeClusters(codes, text, memorySummary);

  const causes = [];
  const pushCause = (label, score, why) => {
    const clean = calmCauseLabel(label);
    if (!clean) return;
    causes.push({ label: clean, score, why });
  };

  if (diagnosticEngine?.topIssue) {
    pushCause(
      diagnosticEngine.topIssue,
      diagnosticEngine?.confidence >= 0.8 ? 11 : diagnosticEngine?.confidence >= 0.64 ? 9 : 7,
      "supported by internal diagnostic matching"
    );
  }

  if (diagnosticEngine?.rankedFindings?.length) {
    for (const item of diagnosticEngine.rankedFindings.slice(0, 3)) {
      if (!item?.issueName) continue;
      pushCause(item.issueName, Number(item?.score || 0), "supported by ranked internal diagnostic findings");
    }
  }

  if (clusters.length > 0) {
    for (const cluster of clusters.slice(0, 2)) {
      const hypotheses = getClusterHypotheses(cluster.key, codes, combined);
      for (const h of hypotheses) {
        pushCause(h.label, h.score, `${cluster.reason}; ${h.why}`);
      }
    }
  }

  if (
    combined.includes("misfire") ||
    combined.includes("rough idle") ||
    combined.includes("hesitation") ||
    combined.includes("check engine") ||
    combined.includes("shake") ||
    combined.includes("shakes")
  ) {
    pushCause("ignition-side misfire", 8, "rough idle, hesitation, or shaking fits ignition or combustion weakness");
    pushCause("vacuum leak or unmetered air issue", 7, "idle-sensitive shake often overlaps with airflow imbalance");
    pushCause("fuel delivery imbalance", 6, "fuel-side imbalance remains possible until codes confirm the cylinder or system");
  }

  if (combined.includes("overheating") || combined.includes("coolant") || combined.includes("running hot")) {
    pushCause("cooling-system pressure loss or circulation issue", 8, "heat pattern points toward cooling-system logic");
    pushCause("thermostat, trapped air, or weak water-pump path", 7, "common cooling-system branch");
  }

  if (combined.includes("knock")) {
    pushCause("engine knock or combustion knock pattern", 8, "knock wording raises mechanical or combustion concern");
    pushCause("spark knock under load", 6, "lighter knock language can fit detonation under load");
  }

  if (combined.includes("tick") || combined.includes("ticking")) {
    pushCause("top-end ticking, injector tick, or valvetrain-side noise", 7, "repetitive ticking language supports that path");
  }

  if (combined.includes("squeal")) {
    pushCause("belt, pulley, or bearing noise", 7, "squeal pattern usually fits the accessory side first");
  }

  if (combined.includes("battery") || combined.includes("alternator")) {
    pushCause("battery, alternator, or connection weakness", 7, "charging-related wording supports that path");
  }

  if (Array.isArray(enginePack?.simple_engine_issue_matches)) {
    for (const item of enginePack.simple_engine_issue_matches.slice(0, 4)) {
      if (!item?.label) continue;
      pushCause(item.label, 7, "matched internal engine issue pattern");
    }
  }

  if (enginePack?.intel_best_pattern?.label) {
    pushCause(enginePack.intel_best_pattern.label, 8, "matched structured engine intel");
  }

  if (Array.isArray(verifiedData) && verifiedData.length > 0) {
    pushCause("verified data refinement", 4, "search-supported refinement exists");
  }

  return causes
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .filter((item, index, arr) => {
      const key = normalizeToken(item.label);
      return arr.findIndex((x) => normalizeToken(x.label) === key) === index;
    })
    .slice(0, 5);
}

function buildTests({
  memorySummary = {},
  diagnosticEngine = {},
  topCause = "",
  domain = "general",
  clusterKey = "",
}) {
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);
  const repairs = lowerJoined(memorySummary?.prior_repairs || []);
  const tests = [];
  const pushTest = (value) => {
    const clean = friendlyLabel(value);
    if (clean) tests.push(clean);
  };

  if (Array.isArray(diagnosticEngine?.firstChecks) && diagnosticEngine.firstChecks.length > 0) {
    for (const check of diagnosticEngine.firstChecks.slice(0, 4)) pushTest(check);
  }

  if (
    clusterKey === "abs_brake_stability" ||
    domain === "brakes" ||
    topCause.toLowerCase().includes("abs") ||
    topCause.toLowerCase().includes("brake")
  ) {
    pushTest("confirm whether the ABS or brake codes return after clearing");
    pushTest("inspect the ABS module, actuator, hydraulic unit, and main connector");
    pushTest("check shared power, fuse, ground, and connector condition");
  }

  if (
    topCause.toLowerCase().includes("ignition") ||
    topCause.toLowerCase().includes("misfire") ||
    symptomsText.includes("misfire") ||
    symptomsText.includes("rough idle") ||
    symptomsText.includes("shake")
  ) {
    pushTest("scan for fault codes if available");
    pushTest("inspect spark plugs and ignition coils");
    pushTest("check intake hoses and manifold area for a vacuum leak");
  }

  if (
    topCause.toLowerCase().includes("cooling") ||
    symptomsText.includes("overheating") ||
    symptomsText.includes("coolant")
  ) {
    pushTest("check coolant level when cold");
    pushTest("look for visible leaks or dried coolant marks");
    pushTest("confirm radiator fan and thermostat behavior");
  }

  if (topCause.toLowerCase().includes("knock")) {
    pushTest("check oil level and warning lights first");
    pushTest("notice whether the sound is a light fast tick or a deeper knock under load");
  }

  if (
    topCause.toLowerCase().includes("belt") ||
    topCause.toLowerCase().includes("pulley") ||
    topCause.toLowerCase().includes("bearing")
  ) {
    pushTest("inspect belt condition and pulley alignment");
    pushTest("listen around the accessory belt side");
  }

  if (
    topCause.toLowerCase().includes("charging") ||
    topCause.toLowerCase().includes("battery") ||
    symptomsText.includes("battery issue") ||
    symptomsText.includes("alternator issue")
  ) {
    pushTest("test battery voltage with engine off and running");
    pushTest("inspect battery terminals and ground connection");
    pushTest("check alternator output under load");
  }

  if (clusterKey === "suspension_height_control") {
    pushTest("check whether one corner drops more than the others");
    pushTest("check compressor operation, valve block, and visible air leaks");
    pushTest("inspect height-sensor linkage and wiring");
  }

  if (repairs.includes("spark plugs") && topCause.toLowerCase().includes("ignition")) {
    pushTest("because plugs were already replaced, look closer at coils, installation quality, or air leaks");
  }

  return dedupe(tests).slice(0, 4);
}

function buildQuestions({
  memorySummary = {},
  diagnosticEngine = {},
  topCause = "",
  clusterKey = "",
  userIntent = {},
}) {
  const questions = [];
  const codes = Array.isArray(memorySummary?.fault_codes) ? memorySummary.fault_codes : [];
  const unresolved = lowerJoined(memorySummary?.unresolved_points || []);
  const symptomsText = lowerJoined(memorySummary?.symptoms || []);
  const causeText = String(topCause || "").toLowerCase();

  const pushQuestion = (q) => {
    if (!q) return;
    if (questions.length > 0) return;
    questions.push(q);
  };

  const hasCheckEngineClue =
    symptomsText.includes("check engine") ||
    symptomsText.includes("check-engine") ||
    symptomsText.includes("warning light") ||
    unresolved.includes("check engine") ||
    unresolved.includes("check-engine");

  const hasMisfireClue =
    symptomsText.includes("rough idle") ||
    symptomsText.includes("misfire") ||
    symptomsText.includes("shake") ||
    symptomsText.includes("shakes") ||
    causeText.includes("misfire") ||
    causeText.includes("ignition");

  if (
    Array.isArray(diagnosticEngine?.cautionFlags) &&
    diagnosticEngine.cautionFlags.includes("timing-risk")
  ) {
    pushQuestion("Does the noise stay for only a few seconds on cold start, or is it lasting longer now?");
  }

  if (
    questions.length === 0 &&
    (clusterKey === "abs_brake_stability" ||
      causeText.includes("abs") ||
      causeText.includes("brake"))
  ) {
    pushQuestion("Is the brake pedal feeling normal, soft, or weaker than usual?");
  }

  if (
    questions.length === 0 &&
    codes.length === 0 &&
    hasMisfireClue &&
    !hasCheckEngineClue
  ) {
    pushQuestion("One thing I’d want to confirm: is the check-engine light steady or flashing?");
  }

  if (
    questions.length === 0 &&
    hasMisfireClue &&
    !unresolved.includes("idle_behavior_known")
  ) {
    pushQuestion("Does the shaking feel strongest at idle, or does it continue while accelerating?");
  }

  if (questions.length === 0 && causeText.includes("knock")) {
    pushQuestion("Is it a light fast tick, or a deeper knock that gets stronger under load?");
  }

  if (questions.length === 0 && causeText.includes("cooling")) {
    pushQuestion("Does the temperature rise mainly while driving, at idle, or both?");
  }

  if (questions.length === 0 && userIntent.purchaseIntent) {
    pushQuestion("Before buying it, do you know if these faults are current or only old stored codes?");
  }

  if (
    questions.length === 0 &&
    unresolved.includes("fault_codes_unknown") &&
    !hasCheckEngineClue
  ) {
    pushQuestion("If you do not have a scanner yet, is the warning light steady or flashing?");
  }

  return dedupe(questions).slice(0, 1);
}

function detectSeverity({
  memorySummary = {},
  diagnosticEngine = {},
  topCause = "",
  text = "",
  clusterKey = "",
}) {
  if (diagnosticEngine?.riskLevel === "high") return "urgent";
  if (diagnosticEngine?.riskLevel === "medium") return "high";

  const combined = `${lowerJoined(memorySummary?.symptoms || [])} | ${String(text || "").toLowerCase()} | ${String(
    topCause || ""
  ).toLowerCase()}`;

  if (
    combined.includes("brake weakness") ||
    combined.includes("weak brake") ||
    combined.includes("steering failure") ||
    combined.includes("oil pressure") ||
    combined.includes("burning smell") ||
    combined.includes("fuel leak") ||
    combined.includes("severe overheating") ||
    combined.includes("flashing check engine") ||
    combined.includes("loss of braking") ||
    combined.includes("loss of steering") ||
    topCause.toLowerCase().includes("engine knock")
  ) {
    return "urgent";
  }

  if (
    clusterKey === "abs_brake_stability" ||
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
    combined.includes("alternator") ||
    clusterKey === "suspension_height_control"
  ) {
    return "medium";
  }

  return "low";
}

function detectDomain(topCause = "", text = "", clusterKey = "", diagnosticEngine = {}) {
  const value = `${String(topCause || "").toLowerCase()} | ${String(text || "").toLowerCase()} | ${String(
    clusterKey || ""
  ).toLowerCase()} | ${String(diagnosticEngine?.topIssue || "").toLowerCase()}`;

  if (
    value.includes("ignition") ||
    value.includes("misfire") ||
    value.includes("vacuum") ||
    value.includes("injector") ||
    value.includes("knock") ||
    value.includes("tick") ||
    value.includes("timing") ||
    value.includes("chain") ||
    value.includes("phaser")
  ) return "engine";

  if (value.includes("cooling") || value.includes("coolant") || value.includes("thermostat")) return "cooling";
  if (value.includes("battery") || value.includes("alternator") || value.includes("charging") || value.includes("voltage")) return "electrical";
  if (value.includes("abs") || value.includes("brake") || value.includes("stability")) return "brakes";
  if (value.includes("suspension") || value.includes("ride height") || value.includes("height control")) return "suspension";
  if (value.includes("steering")) return "steering";

  return "general";
}

function deriveMediaHints({ memorySummary = {}, text = "" }) {
  const combined = `${String(text || "").toLowerCase()} | ${lowerJoined(memorySummary?.symptoms || [])} | ${lowerJoined(
    memorySummary?.unresolved_points || []
  )}`;

  return {
    imageSignals:
      combined.includes("photo") ||
      combined.includes("image") ||
      combined.includes("picture") ||
      combined.includes("dashboard") ||
      combined.includes("scanner screen"),

    audioSignals:
      combined.includes("sound") ||
      combined.includes("noise") ||
      combined.includes("audio") ||
      combined.includes("recording"),

    gpsSignals:
      combined.includes("near me") ||
      combined.includes("nearby") ||
      combined.includes("closest shop") ||
      combined.includes("workshop near") ||
      combined.includes("mechanic near") ||
      combined.includes("gps"),
  };
}

function shouldUseSearch({
  placesIntent = false,
  verifiedData = [],
  verifiedWorkshops = [],
  internalIntelStrong = false,
  userIntent = {},
  mediaHints = {},
  severity = "medium",
}) {
  if (placesIntent) return true;
  if (mediaHints?.gpsSignals) return true;
  if (Array.isArray(verifiedWorkshops) && verifiedWorkshops.length > 0) return true;

  if (userIntent?.purchaseIntent && Array.isArray(verifiedData) && verifiedData.length === 0) return true;

  if (severity === "urgent" && Array.isArray(verifiedWorkshops) && verifiedWorkshops.length === 0) {
    return false;
  }

  if (Array.isArray(verifiedData) && verifiedData.length > 0) return false;
  if (internalIntelStrong) return false;

  return false;
}

function buildSearchQuery({
  topCause = "",
  memorySummary = {},
  text = "",
  domain = "general",
  clusterKey = "",
  userIntent = {},
}) {
  const vehicle = memorySummary?.vehicle || {};
  const vehicleText = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine].filter(Boolean).join(" ");
  const codes = uniqueCodesFromMemory(memorySummary, text).slice(0, 5).join(" ");
  const symptomLead = Array.isArray(memorySummary?.symptoms) ? memorySummary.symptoms.slice(0, 3).join(" ") : "";

  const intentLead = userIntent.purchaseIntent
    ? "pre purchase inspection risk"
    : userIntent.safetyIntent
    ? "drive safety"
    : "diagnosis";

  return [vehicleText, codes, clusterKey, domain, topCause, symptomLead, intentLead, text]
    .filter(Boolean)
    .join(" ")
    .trim()
    .slice(0, 240);
}

function buildWorkshopSearchQuery({
  memorySummary = {},
  topCause = "",
  domain = "general",
  clusterKey = "",
}) {
  const vehicle = memorySummary?.vehicle || {};
  const vehicleText = [vehicle?.make, vehicle?.model].filter(Boolean).join(" ");

  let specialty = "auto repair";
  if (clusterKey === "abs_brake_stability" || domain === "brakes") specialty = "ABS brake specialist";
  else if (domain === "electrical") specialty = "auto electrical specialist";
  else if (clusterKey === "suspension_height_control" || domain === "suspension") specialty = "suspension specialist";
  else if (domain === "engine") specialty = "engine diagnostics specialist";

  return [vehicleText, specialty, topCause].filter(Boolean).join(" ").trim().slice(0, 180);
}

function buildSafetyAdvice({
  severity = "medium",
  clusterKey = "",
  topCause = "",
  userIntent = {},
  diagnosticEngine = {},
}) {
  const cautionFlags = safeArray(diagnosticEngine?.cautionFlags || []);

  if (
    severity === "urgent" ||
    topCause.toLowerCase().includes("engine knock") ||
    cautionFlags.includes("overheat-risk")
  ) {
    return "Limit driving until this is checked. The risk is not confirmed, but this pattern deserves prompt attention.";
  }

  if (clusterKey === "abs_brake_stability") {
    return "If the brake pedal feels normal, move carefully and inspect soon. If the pedal feels weak or braking changes, do not keep driving.";
  }

  if (
    severity === "high" ||
    cautionFlags.includes("timing-risk") ||
    cautionFlags.includes("mechanical-valvetrain-risk") ||
    cautionFlags.includes("misfire-cluster")
  ) {
    return "Short, gentle driving may be okay, but it should be checked soon—especially if the warning light flashes or the symptom gets worse.";
  }

  if (userIntent?.safetyIntent) {
    return "It does not sound like an emergency from the description alone, but it should not be ignored for long.";
  }

  return "No severe danger is proven from the description, but the fault path still needs confirmation.";
}

function buildPurchaseJudgment({
  userIntent = {},
  severity = "medium",
  clusterKey = "",
  topCause = "",
  codes = [],
}) {
  if (!userIntent?.purchaseIntent) return "";

  const count = safeArray(codes).length;

  if (
    severity === "urgent" ||
    clusterKey === "abs_brake_stability" ||
    topCause.toLowerCase().includes("module") ||
    count >= 3
  ) {
    return "For a purchase, I would treat this as negotiation risk or a possible walk-away case unless it is diagnosed clearly first.";
  }

  if (severity === "high") {
    return "For a purchase, this is negotiable, but I would not ignore it before buying.";
  }

  return "For a purchase, this may be manageable, but it should be verified before buying.";
}

function buildEvidenceSummary({
  memorySummary = {},
  diagnosticEngine = {},
  codes = [],
  clusterKey = "",
  mediaHints = {},
}) {
  const summary = [];

  if (diagnosticEngine?.topIssue) summary.push(`internal pattern: ${friendlyLabel(diagnosticEngine.topIssue)}`);
  if (codes.length > 0) summary.push(`fault codes: ${codes.join(", ")}`);
  if (clusterKey) summary.push(`system area: ${friendlyLabel(clusterKey)}`);
  if (mediaHints?.imageSignals) summary.push("image clue mentioned");
  if (mediaHints?.audioSignals) summary.push("sound clue mentioned");

  const symptoms = safeArray(memorySummary?.symptoms).slice(0, 3).map(friendlyLabel);
  if (symptoms.length > 0) summary.push(`symptoms: ${symptoms.join(" | ")}`);

  const vehicle = memorySummary?.vehicle || {};
  const vehicleText = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine].filter(Boolean).join(" ");
  if (vehicleText) summary.push(`vehicle: ${vehicleText}`);

  return summary;
}

export function buildResponsePlan({
  locale = "en",
  text = "",
  placesIntent = false,
  enginePack = {},
  diagnosticEngine = {},
  diagnosticMemory = {},
  verifiedData = [],
  verifiedWorkshops = [],
  internalIntelStrong = false,
}) {
  const memorySummary = diagnosticMemory?.current_case_summary || {};
  const codes = uniqueCodesFromMemory(memorySummary, text);
  const userIntent = detectUserIntent(text, memorySummary);
  const mediaHints = deriveMediaHints({ memorySummary, text });
  const clusters = classifyCodeClusters(codes, text, memorySummary);
  const primaryCluster = clusters[0]?.key || "";

  const ranked = rankLikelyCauses({
    memorySummary,
    enginePack,
    diagnosticEngine,
    text,
    verifiedData,
  });

  const topCause = calmCauseLabel(
    diagnosticEngine?.topIssue ||
      ranked[0]?.label ||
      "general mechanical fault path that needs narrowing"
  );

  const severity = detectSeverity({
    memorySummary,
    diagnosticEngine,
    topCause,
    text,
    clusterKey: primaryCluster,
  });

  const domain = detectDomain(topCause, text, primaryCluster, diagnosticEngine);

  const tests = buildTests({
    memorySummary,
    diagnosticEngine,
    topCause,
    domain,
    clusterKey: primaryCluster,
  });

  const questions = buildQuestions({
    memorySummary,
    diagnosticEngine,
    topCause,
    clusterKey: primaryCluster,
    userIntent,
  });

  const needsSearch = shouldUseSearch({
    placesIntent,
    verifiedData,
    verifiedWorkshops,
    internalIntelStrong,
    userIntent,
    mediaHints,
    severity,
  });

  const query = needsSearch
    ? buildSearchQuery({
        topCause,
        memorySummary,
        text,
        domain,
        clusterKey: primaryCluster,
        userIntent,
      })
    : "";

  const workshopQuery =
    placesIntent || mediaHints?.gpsSignals
      ? buildWorkshopSearchQuery({
          memorySummary,
          topCause,
          domain,
          clusterKey: primaryCluster,
        })
      : "";

  const safetyAdvice = buildSafetyAdvice({
    severity,
    clusterKey: primaryCluster,
    topCause,
    userIntent,
    diagnosticEngine,
  });

  const purchaseJudgment = buildPurchaseJudgment({
    userIntent,
    severity,
    clusterKey: primaryCluster,
    topCause,
    codes,
  });

  const evidenceSummary = buildEvidenceSummary({
    memorySummary,
    diagnosticEngine,
    codes,
    clusterKey: primaryCluster,
    mediaHints,
  });

  const likelyCauses = ranked.map((item) => calmCauseLabel(item.label)).filter(Boolean).slice(0, 4);

  return {
    severity,
    domain,
    cluster: friendlyLabel(primaryCluster),
    strongest_hypothesis: topCause,
    likely_causes: likelyCauses,
    likely_cause_reasons: ranked.map((item) => item.why).slice(0, 4),
    tests,
    must_ask: questions,
    needs_search: needsSearch,
    query,
    workshop_query: workshopQuery,
    safety_advice: safetyAdvice,
    purchase_judgment: purchaseJudgment,
    codes,
    evidence_summary: evidenceSummary,
    media_hints: mediaHints,
    user_intent: userIntent,
    planner_text: buildPlannerText({
      locale,
      severity,
      domain,
      clusterKey: friendlyLabel(primaryCluster),
      topCause,
      ranked,
      tests,
      questions,
      memorySummary,
      codes,
      safetyAdvice,
      purchaseJudgment,
      evidenceSummary,
      mediaHints,
      userIntent,
      query,
      workshopQuery,
      diagnosticEngine,
    }),
  };
}

export function buildPlannerText({
  locale = "en",
  severity = "medium",
  domain = "general",
  clusterKey = "",
  topCause = "",
  ranked = [],
  tests = [],
  questions = [],
  memorySummary = {},
  codes = [],
  safetyAdvice = "",
  purchaseJudgment = "",
  evidenceSummary = [],
  mediaHints = {},
  userIntent = {},
  query = "",
  workshopQuery = "",
  diagnosticEngine = {},
}) {
  const cleanCauses = dedupe((ranked || []).map((x) => calmCauseLabel(x.label)).filter(Boolean)).slice(0, 4);
  const cleanTests = dedupe((tests || []).map(friendlyLabel)).slice(0, 4);
  const cleanQuestions = dedupe(questions || []).slice(0, 1);

  return `
FIXLENS_DOCTOR_PLAN:
LOCALE=${JSON.stringify(locale)}
SEVERITY=${JSON.stringify(severity)}
DOMAIN=${JSON.stringify(domain)}
SYSTEM_AREA=${JSON.stringify(clusterKey)}
PRIMARY_DIRECTION=${JSON.stringify(calmCauseLabel(topCause))}
CODES=${JSON.stringify(codes || [])}
POSSIBLE_CAUSES=${JSON.stringify(cleanCauses)}
NEXT_CHECKS=${JSON.stringify(cleanTests)}
FOLLOW_UP_QUESTIONS=${JSON.stringify(cleanQuestions)}
DRIVING_CONDITION=${JSON.stringify(safetyAdvice || "")}
PURCHASE_NOTE=${JSON.stringify(purchaseJudgment || "")}
EVIDENCE=${JSON.stringify(evidenceSummary || [])}
MEDIA_HINTS=${JSON.stringify(mediaHints || {})}
USER_INTENT=${JSON.stringify(userIntent || {})}
SEARCH_QUERY=${JSON.stringify(query || "")}
WORKSHOP_QUERY=${JSON.stringify(workshopQuery || "")}
MEMORY_SUMMARY=${JSON.stringify(memorySummary || {})}
INTERNAL_ENGINE_NOTE=${JSON.stringify({
    topIssue: calmCauseLabel(diagnosticEngine?.topIssue || ""),
    topEngine: diagnosticEngine?.topEngine || null,
    riskLevel: diagnosticEngine?.riskLevel || null,
    cautionFlags: diagnosticEngine?.cautionFlags || [],
  })}

FINAL_RESPONSE_RULES:
- Write only the final user-facing answer.
- Do NOT mention confidence percentages.
- Do NOT expose internal tokens such as check_engine, cluster names, riskLevel, engine scores, planner data, or diagnostic engine metadata.
- Do NOT say "Most likely cause".
- Do NOT write "Optional".
- Do NOT sound like a code glossary.
- Do NOT say "go to a shop", "nearby shop", or "check location" unless the user explicitly asks for nearby help.
- Do NOT over-explain.
- Use calm second-opinion language: "Based on what you described...", "This could be related to...", "Common possibilities include..."
- Give 2 to 4 possible causes, ordered from simple/common to more serious.
- Give 2 to 4 practical checks.
- Driving condition must be calm and specific.
- Ask at most 1 follow-up question only if it changes the next diagnostic step.
- If FOLLOW_UP_QUESTIONS is empty, do not ask any question.
- Keep the answer short, premium, and human.

PREFERRED_OUTPUT_FORMAT:
Diagnosis:
[One calm sentence. No absolute conclusion.]

Possible causes:
- [cause 1]
- [cause 2]
- [cause 3]

What to check first:
1. [simple check]
2. [simple check]
3. [simple check]

Driving condition:
[calm safety note]

If needed:
[Only one natural follow-up question, without labeling it.]
`.trim();
}
