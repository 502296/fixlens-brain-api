// responsePlanner.js
// FixLens Response Planner v3.0
// Conversation-first planner
// Built to support mechanic-style answers, not article-style output

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

function uniqueCodesFromMemory(memorySummary = {}, text = "") {
  const rawCodes = [];

  if (Array.isArray(memorySummary?.fault_codes)) {
    rawCodes.push(...memorySummary.fault_codes);
  }

  if (Array.isArray(memorySummary?.codes)) {
    rawCodes.push(...memorySummary.codes);
  }

  const textMatches = String(text || "").match(/\b([PCUB][0-9]{4}|[A-Z][0-9]{4})\b/gi);
  if (textMatches?.length) rawCodes.push(...textMatches);

  return dedupe(rawCodes.map((x) => String(x || "").toUpperCase()));
}

function detectUserIntent(text = "", memorySummary = {}) {
  const combined = `${String(text || "").toLowerCase()} | ${lowerJoined(
    memorySummary?.symptoms || []
  )} | ${lowerJoined(memorySummary?.unresolved_points || [])}`;

  const purchaseIntent =
    combined.includes("buy this car") ||
    combined.includes("worth buying") ||
    combined.includes("should i buy") ||
    combined.includes("before i buy") ||
    combined.includes("pre purchase") ||
    combined.includes("pre-purchase") ||
    combined.includes("inspection before buying");

  const safetyIntent =
    combined.includes("safe to drive") ||
    combined.includes("can i drive") ||
    combined.includes("is it safe") ||
    combined.includes("should i keep driving") ||
    combined.includes("drive it like this");

  const priceRiskIntent =
    combined.includes("expensive") ||
    combined.includes("costly") ||
    combined.includes("repair cost") ||
    combined.includes("big repair") ||
    combined.includes("how much") ||
    combined.includes("worth fixing");

  return {
    purchaseIntent,
    safetyIntent,
    priceRiskIntent,
  };
}

function classifyCodeClusters(codes = [], text = "", memorySummary = {}) {
  const upperCodes = safeArray(codes).map((x) => String(x || "").toUpperCase());
  const combined = `${upperCodes.join(" | ")} | ${String(text || "").toLowerCase()} | ${lowerJoined(
    memorySummary?.symptoms || []
  )}`;

  const clusters = [];
  const addCluster = (key, score, reason) => {
    clusters.push({ key, score, reason });
  };

  const hasCodePrefix = (prefixes = []) =>
    upperCodes.some((c) => prefixes.some((p) => c.startsWith(p)));

  if (
    hasCodePrefix(["C12", "C13"]) ||
    combined.includes("abs") ||
    combined.includes("brake") ||
    combined.includes("stability") ||
    combined.includes("traction")
  ) {
    addCluster(
      "abs_brake_stability",
      10,
      "multiple brake or ABS clues point toward one shared subsystem"
    );
  }

  if (
    hasCodePrefix(["P03"]) ||
    combined.includes("misfire") ||
    combined.includes("rough idle") ||
    combined.includes("hesitation")
  ) {
    addCluster(
      "misfire_combustion",
      9,
      "misfire and combustion clues line up around one central engine fault path"
    );
  }

  if (
    hasCodePrefix(["P01", "P02"]) ||
    combined.includes("fuel trim") ||
    combined.includes("vacuum") ||
    combined.includes("lean") ||
    combined.includes("rich")
  ) {
    addCluster(
      "air_fuel_metering",
      8,
      "air-fuel metering clues suggest one fueling or airflow path"
    );
  }

  if (
    combined.includes("coolant") ||
    combined.includes("overheating") ||
    combined.includes("running hot")
  ) {
    addCluster(
      "cooling_system",
      9,
      "cooling-system behavior points toward one temperature-control path"
    );
  }

  if (
    combined.includes("battery") ||
    combined.includes("alternator") ||
    combined.includes("voltage") ||
    combined.includes("charging")
  ) {
    addCluster(
      "charging_voltage",
      8,
      "charging and voltage behavior can create a shared electrical fault path"
    );
  }

  if (
    combined.includes("air suspension") ||
    combined.includes("ride height") ||
    combined.includes("suspension") ||
    upperCodes.some((c) => c.startsWith("C17") || c.startsWith("C18"))
  ) {
    addCluster(
      "suspension_height_control",
      7,
      "height-control and suspension clues may belong to one control path"
    );
  }

  if (
    combined.includes("communication") ||
    combined.includes("network") ||
    upperCodes.some((c) => c.startsWith("U0") || c.startsWith("U1"))
  ) {
    addCluster(
      "network_communication",
      8,
      "network faults often come from one shared power, wiring, or module issue"
    );
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
    push(
      "central ABS or brake control fault path",
      10,
      "the cluster looks more central than a single random sensor failure"
    );
    push(
      "ABS actuator, hydraulic unit, or module-side issue",
      9,
      "multiple brake-control clues often fit the central ABS side better than separate parts"
    );
    push(
      "shared wiring, connector, ground, or power issue affecting the ABS system",
      8,
      "one shared electrical path can trigger several related chassis faults"
    );

    if (upperCodes.includes("C1252") || upperCodes.includes("C1256")) {
      push(
        "hydraulic or actuator-side ABS issue is especially plausible here",
        9,
        "those codes strengthen the actuator or hydraulic path"
      );
    }

    if (upperCodes.includes("C1210")) {
      push(
        "stability control may be reacting to a deeper ABS-side fault",
        7,
        "that code often fits into a wider brake-control chain"
      );
    }
  }

  if (clusterKey === "misfire_combustion") {
    push(
      "ignition-side weakness such as coil, plug, or related ignition path",
      9,
      "misfire behavior usually points to ignition first unless the pattern says otherwise"
    );
    push(
      "vacuum leak or unmetered air issue",
      8,
      "misfire with rough idle or hesitation often fits an air-leak path"
    );
    push(
      "injector or fuel-delivery imbalance",
      7,
      "fuel-side imbalance can mimic ignition weakness"
    );

    if (text.includes("flashing")) {
      push(
        "active severe misfire with possible catalyst risk",
        10,
        "flashing warning behavior raises the urgency"
      );
    }
  }

  if (clusterKey === "air_fuel_metering") {
    push(
      "vacuum leak or intake leak",
      9,
      "air-fuel imbalance often starts with unmetered air"
    );
    push(
      "MAF or MAP measurement issue",
      7,
      "bad airflow reading can distort fueling"
    );
    push(
      "fuel-pressure or injector imbalance",
      7,
      "fuel-side problems remain realistic here"
    );
  }

  if (clusterKey === "cooling_system") {
    push(
      "cooling system pressure loss or circulation problem",
      9,
      "the heat behavior fits cooling-system logic first"
    );
    push(
      "thermostat, trapped air, or weak water-pump path",
      8,
      "that is a common cooling branch"
    );
    push(
      "fan control issue if it worsens at idle or traffic",
      7,
      "idle-heavy overheating shifts suspicion toward fan behavior"
    );
  }

  if (clusterKey === "charging_voltage") {
    push(
      "charging-system weakness from battery, alternator, or bad connections",
      9,
      "voltage-related symptoms often start there"
    );
    push(
      "ground or terminal issue",
      8,
      "one poor connection can create unstable electrical behavior"
    );
  }

  if (clusterKey === "suspension_height_control") {
    push(
      "air-suspension compressor, valve block, or height-control fault",
      8,
      "ride-height behavior often points to one central path"
    );
    push(
      "height sensor or related wiring issue",
      7,
      "sensor-side fault remains possible"
    );
    push(
      "air leak in a bag, line, or circuit",
      8,
      "air loss is a common reason for height drop"
    );
  }

  if (clusterKey === "network_communication") {
    push(
      "module communication fault caused by voltage, wiring, or one failing control unit",
      8,
      "network faults usually come from a shared root cause"
    );
    push(
      "battery or charging instability creating misleading communication faults",
      7,
      "low voltage can cascade into network errors"
    );
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
    causes.push({ label, score, why });
  };

  if (diagnosticEngine?.topIssue) {
    pushCause(
      String(diagnosticEngine.topIssue),
      diagnosticEngine?.confidence >= 0.8 ? 11 : diagnosticEngine?.confidence >= 0.64 ? 9 : 7,
      "matched strongly by the internal diagnostic engine"
    );
  }

  if (diagnosticEngine?.rankedFindings?.length) {
    for (const item of diagnosticEngine.rankedFindings.slice(0, 3)) {
      if (!item?.issueName) continue;
      pushCause(
        String(item.issueName),
        Number(item?.score || 0),
        "supported by ranked internal diagnostic findings"
      );
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
    combined.includes("check engine")
  ) {
    pushCause(
      "ignition-side misfire",
      8,
      "rough idle, hesitation, or misfire behavior fits ignition or combustion weakness"
    );
    pushCause(
      "vacuum leak or unmetered air issue",
      7,
      "idle-sensitive shake often overlaps with airflow imbalance"
    );
    pushCause(
      "fuel delivery imbalance",
      6,
      "fuel-side imbalance remains possible when ignition is not fully confirmed"
    );
  }

  if (
    combined.includes("overheating") ||
    combined.includes("coolant") ||
    combined.includes("running hot")
  ) {
    pushCause(
      "cooling-system pressure loss or circulation problem",
      8,
      "the heat pattern points toward a cooling path"
    );
    pushCause(
      "thermostat, trapped air, or weak water-pump path",
      7,
      "common cooling-system branch"
    );
  }

  if (combined.includes("knock")) {
    pushCause(
      "true engine knock or heavy mechanical knock",
      8,
      "knock wording raises mechanical concern"
    );
    pushCause(
      "spark knock or detonation under load",
      6,
      "lighter knock language can still fit combustion knock"
    );
  }

  if (
    combined.includes("tick") ||
    combined.includes("ticking")
  ) {
    pushCause(
      "top-end ticking, injector tick, or valvetrain-side noise",
      7,
      "repetitive ticking language supports that path"
    );
  }

  if (combined.includes("squeal")) {
    pushCause(
      "belt, pulley, or bearing noise",
      7,
      "squeal pattern usually fits the accessory side first"
    );
  }

  if (
    combined.includes("battery") ||
    combined.includes("alternator")
  ) {
    pushCause(
      "charging-system weakness from battery, alternator, or connection issue",
      7,
      "charging-related wording supports that path"
    );
  }

  if (Array.isArray(enginePack?.simple_engine_issue_matches)) {
    for (const item of enginePack.simple_engine_issue_matches.slice(0, 4)) {
      if (!item?.label) continue;
      pushCause(String(item.label), 7, "matched internal engine issue pattern");
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
      "verified external data supports narrowing this case",
      4,
      "search-supported refinement exists"
    );
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
    if (value) tests.push(value);
  };

  if (Array.isArray(diagnosticEngine?.firstChecks) && diagnosticEngine.firstChecks.length > 0) {
    for (const check of diagnosticEngine.firstChecks.slice(0, 4)) {
      pushTest(check);
    }
  }

  if (
    clusterKey === "abs_brake_stability" ||
    domain === "brakes" ||
    topCause.toLowerCase().includes("abs") ||
    topCause.toLowerCase().includes("brake")
  ) {
    pushTest("confirm whether the ABS or brake codes return immediately after clearing");
    pushTest("inspect the ABS module, actuator, hydraulic unit, and main connector before blaming random sensors");
    pushTest("check shared power, fuse, ground, and connector condition for the ABS side");
  }

  if (
    topCause.toLowerCase().includes("ignition") ||
    symptomsText.includes("misfire") ||
    symptomsText.includes("rough idle")
  ) {
    pushTest("scan for fault codes if available");
    pushTest("inspect coils and spark plugs first");
    pushTest("check for intake or vacuum leak around hoses and manifold");
  }

  if (
    topCause.toLowerCase().includes("cooling") ||
    symptomsText.includes("overheating") ||
    symptomsText.includes("coolant")
  ) {
    pushTest("check coolant level cold and inspect for pressure loss");
    pushTest("look for visible leak, dried coolant marks, or trapped air");
    pushTest("confirm radiator fan and thermostat behavior");
  }

  if (topCause.toLowerCase().includes("knock")) {
    pushTest("check oil level and warning lights immediately");
    pushTest("compare whether the sound is a light tick or a deep load-sensitive knock");
  }

  if (
    topCause.toLowerCase().includes("belt") ||
    topCause.toLowerCase().includes("pulley") ||
    topCause.toLowerCase().includes("bearing")
  ) {
    pushTest("inspect belt condition and pulley alignment");
    pushTest("listen around the accessory side");
  }

  if (
    topCause.toLowerCase().includes("charging") ||
    symptomsText.includes("battery issue") ||
    symptomsText.includes("alternator issue")
  ) {
    pushTest("test battery voltage with engine off and running");
    pushTest("inspect terminals and ground connection");
    pushTest("check alternator output under load");
  }

  if (clusterKey === "suspension_height_control") {
    pushTest("check whether one corner drops more than the others");
    pushTest("check compressor operation, valve block, and visible air leaks");
    pushTest("inspect height-sensor linkage and wiring");
  }

  if (repairs.includes("spark plugs") && topCause.toLowerCase().includes("ignition")) {
    pushTest("since plugs were already replaced, lean more toward coils, install quality, or air-leak path");
  }

  return dedupe(tests).slice(0, 5);
}

function buildQuestions({
  memorySummary = {},
  diagnosticEngine = {},
  topCause = "",
  clusterKey = "",
  userIntent = {},
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

  if (Array.isArray(diagnosticEngine?.cautionFlags) && diagnosticEngine.cautionFlags.includes("timing-risk")) {
    pushQuestion("Is the noise still only a few seconds on cold start, or is it starting to last longer?");
  }

  if (
    clusterKey === "abs_brake_stability" ||
    topCause.toLowerCase().includes("abs") ||
    topCause.toLowerCase().includes("brake")
  ) {
    pushQuestion("Is the ABS or brake warning light on now, and does the pedal feel normal or weak?");
  }

  if (codes.length === 0 && topCause.toLowerCase().includes("ignition")) {
    pushQuestion("Do you have any check-engine codes now, or is the light on without a scan?");
  }

  if (
    symptomsText.includes("rough idle") ||
    symptomsText.includes("misfire")
  ) {
    pushQuestion("Is the shake strongest at idle, and does it smooth out when you give it throttle?");
  }

  if (topCause.toLowerCase().includes("knock")) {
    pushQuestion("Does it sound like a light fast tick, or a deeper knock that gets heavier under load?");
  }

  if (topCause.toLowerCase().includes("cooling")) {
    pushQuestion("Does the temperature rise mainly while driving, at idle, or both?");
  }

  if (userIntent.purchaseIntent) {
    pushQuestion("Before buying it, do you know whether these faults are current or just old stored codes?");
  }

  if (unresolved.includes("fault_codes_unknown")) {
    pushQuestion("If you do not have a scanner yet, is the check-engine light steady or flashing?");
  }

  return dedupe(questions).slice(0, 2);
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

  const combined = `${lowerJoined(memorySummary?.symptoms || [])} | ${String(
    text || ""
  ).toLowerCase()} | ${String(topCause || "").toLowerCase()}`;

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
    topCause.toLowerCase().includes("true engine knock")
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
  const value = `${String(topCause || "").toLowerCase()} | ${String(
    text || ""
  ).toLowerCase()} | ${String(clusterKey || "").toLowerCase()} | ${String(
    diagnosticEngine?.topIssue || ""
  ).toLowerCase()}`;

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

  if (
    value.includes("cooling") ||
    value.includes("coolant") ||
    value.includes("thermostat")
  ) return "cooling";

  if (
    value.includes("battery") ||
    value.includes("alternator") ||
    value.includes("charging") ||
    value.includes("voltage")
  ) return "electrical";

  if (
    value.includes("abs") ||
    value.includes("brake") ||
    value.includes("stability")
  ) return "brakes";

  if (
    value.includes("suspension") ||
    value.includes("ride-height") ||
    value.includes("height-control")
  ) return "suspension";

  if (value.includes("steering")) return "steering";

  return "general";
}

function deriveMediaHints({ memorySummary = {}, text = "" }) {
  const combined = `${String(text || "").toLowerCase()} | ${lowerJoined(
    memorySummary?.symptoms || []
  )} | ${lowerJoined(memorySummary?.unresolved_points || [])}`;

  const imageSignals =
    combined.includes("photo") ||
    combined.includes("image") ||
    combined.includes("picture") ||
    combined.includes("dashboard") ||
    combined.includes("scanner screen");

  const audioSignals =
    combined.includes("sound") ||
    combined.includes("noise") ||
    combined.includes("audio") ||
    combined.includes("recording");

  const gpsSignals =
    combined.includes("near me") ||
    combined.includes("nearby") ||
    combined.includes("closest shop") ||
    combined.includes("workshop near") ||
    combined.includes("mechanic near") ||
    combined.includes("gps") ||
    combined.includes("zip");

  return {
    imageSignals,
    audioSignals,
    gpsSignals,
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

  if (userIntent?.purchaseIntent && Array.isArray(verifiedData) && verifiedData.length === 0) {
    return true;
  }

  if (severity === "urgent" && Array.isArray(verifiedWorkshops) && verifiedWorkshops.length === 0) {
    return true;
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
  const vehicleText = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine]
    .filter(Boolean)
    .join(" ");

  const codes = uniqueCodesFromMemory(memorySummary, text).slice(0, 5).join(" ");
  const symptomLead = Array.isArray(memorySummary?.symptoms)
    ? memorySummary.symptoms.slice(0, 3).join(" ")
    : "";

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
  if (clusterKey === "abs_brake_stability" || domain === "brakes") {
    specialty = "ABS brake specialist";
  } else if (domain === "electrical") {
    specialty = "auto electrical specialist";
  } else if (clusterKey === "suspension_height_control" || domain === "suspension") {
    specialty = "suspension specialist";
  } else if (domain === "engine") {
    specialty = "engine diagnostics specialist";
  }

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
    clusterKey === "abs_brake_stability" ||
    topCause.toLowerCase().includes("true engine knock") ||
    cautionFlags.includes("overheat-risk")
  ) {
    return "driving may be unsafe or should be limited until the core fault is checked";
  }

  if (
    severity === "high" ||
    cautionFlags.includes("timing-risk") ||
    cautionFlags.includes("mechanical-valvetrain-risk") ||
    cautionFlags.includes("misfire-cluster")
  ) {
    return "the vehicle may still move, but it should not be ignored and should be checked soon";
  }

  if (userIntent?.safetyIntent) {
    return "it does not look like the kind of issue to ignore for long, even if it still drives";
  }

  return "no severe danger is proven yet, but the fault path still needs confirmation";
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
    return "this is not a clean pre-purchase picture; it looks more like a negotiation-risk or possible walk-away case unless priced accordingly and properly diagnosed first";
  }

  if (severity === "high") {
    return "this looks negotiable, but not something to ignore before buying";
  }

  return "this may still be manageable, but it should be verified before purchase";
}

function buildEvidenceSummary({
  memorySummary = {},
  diagnosticEngine = {},
  text = "",
  codes = [],
  clusterKey = "",
  mediaHints = {},
}) {
  const summary = [];

  if (diagnosticEngine?.topIssue) {
    summary.push(`internal diagnosis: ${diagnosticEngine.topIssue}`);
  }

  if (codes.length > 0) {
    summary.push(`fault codes detected: ${codes.join(", ")}`);
  }

  if (clusterKey) {
    summary.push(`primary cluster: ${clusterKey}`);
  }

  if (mediaHints?.imageSignals) {
    summary.push("image-based evidence present");
  }

  if (mediaHints?.audioSignals) {
    summary.push("audio or noise evidence may be present");
  }

  const symptoms = safeArray(memorySummary?.symptoms).slice(0, 3);
  if (symptoms.length > 0) {
    summary.push(`symptoms: ${symptoms.join(" | ")}`);
  }

  const vehicle = memorySummary?.vehicle || {};
  const vehicleText = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine]
    .filter(Boolean)
    .join(" ");
  if (vehicleText) {
    summary.push(`vehicle: ${vehicleText}`);
  }

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

  const topCause =
    diagnosticEngine?.topIssue ||
    ranked[0]?.label ||
    "general mechanical fault path still needs narrowing";

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
    placesIntent || mediaHints?.gpsSignals || (severity === "urgent" && verifiedWorkshops.length === 0)
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
    text,
    codes,
    clusterKey: primaryCluster,
    mediaHints,
  });

  return {
    severity,
    domain,
    cluster: primaryCluster,
    strongest_hypothesis: topCause,
    likely_causes: ranked.map((item) => item.label).slice(0, 5),
    likely_cause_reasons: ranked.map((item) => item.why).slice(0, 5),
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
      clusterKey: primaryCluster,
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
  return `
RESPONSE_PLANNER:
LOCALE=${JSON.stringify(locale)}
SEVERITY=${JSON.stringify(severity)}
DOMAIN=${JSON.stringify(domain)}
PRIMARY_CLUSTER=${JSON.stringify(clusterKey)}
STRONGEST_HYPOTHESIS=${JSON.stringify(topCause)}
CODES=${JSON.stringify(codes || [])}
LIKELY_CAUSES=${JSON.stringify((ranked || []).map((x) => x.label))}
LIKELY_CAUSE_REASONS=${JSON.stringify((ranked || []).map((x) => x.why))}
BEST_NEXT_CHECKS=${JSON.stringify(tests || [])}
HIGH_VALUE_FOLLOWUPS=${JSON.stringify(questions || [])}
SAFETY_ADVICE=${JSON.stringify(safetyAdvice || "")}
PURCHASE_JUDGMENT=${JSON.stringify(purchaseJudgment || "")}
EVIDENCE_SUMMARY=${JSON.stringify(evidenceSummary || [])}
MEDIA_HINTS=${JSON.stringify(mediaHints || {})}
USER_INTENT=${JSON.stringify(userIntent || {})}
SEARCH_QUERY=${JSON.stringify(query || "")}
WORKSHOP_QUERY=${JSON.stringify(workshopQuery || "")}
MEMORY_SUMMARY=${JSON.stringify(memorySummary || {})}
DIAGNOSTIC_ENGINE_TOP=${JSON.stringify({
    topIssue: diagnosticEngine?.topIssue || null,
    topEngine: diagnosticEngine?.topEngine || null,
    confidence: diagnosticEngine?.confidence ?? null,
    riskLevel: diagnosticEngine?.riskLevel || null,
    cautionFlags: diagnosticEngine?.cautionFlags || [],
  })}

PLANNER_RULES:
- Lead with STRONGEST_HYPOTHESIS first.
- If DIAGNOSTIC_ENGINE_TOP.confidence is meaningful, trust that path strongly.
- If PRIMARY_CLUSTER exists, treat the case as a unified subsystem diagnosis, not isolated code definitions.
- Do not present all causes as equal.
- Do not answer like a code glossary.
- Explain the case as one mechanic speaking naturally, not as a structured guide.
- Use BEST_NEXT_CHECKS to shape the next move, but do not turn them into headings or bullet lists unless absolutely necessary.
- Use HIGH_VALUE_FOLLOWUPS only if those questions materially change the diagnosis.
- Keep the answer conversational, decisive, and workshop-realistic.
- Avoid headings like "Why it fits", "Next steps", "Safety note", or similar.
- Avoid bullet points unless the situation truly requires them.
- If SAFETY_ADVICE exists, state it briefly and naturally inside the response flow.
- If PURCHASE_JUDGMENT exists, state it clearly and directly.
- If WORKSHOP_QUERY exists and nearby help is requested, local search may be used to find the right specialist.
- Prefer the shortest, sharpest, highest-yield answer first.
`.trim();
}
