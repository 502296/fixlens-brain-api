// responsePlanner.js
// FixLens Response Planner v2.0

function normalizeToken(value = "") {
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

  const textMatches = String(text || "").match(
    /\b([pcub][0-9]{3,4}|[a-z][0-9]{4})\b/gi
  );
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
    combined.includes("اشتريها") ||
    combined.includes("اشتري") ||
    combined.includes("تنصحني اشتري") ||
    combined.includes("افحصها قبل الشراء");

  const safetyIntent =
    combined.includes("safe to drive") ||
    combined.includes("can i drive") ||
    combined.includes("is it safe") ||
    combined.includes("drive it") ||
    combined.includes("أقدر أمشي") ||
    combined.includes("آمنة") ||
    combined.includes("هل أسوقها") ||
    combined.includes("هل امشي بيها");

  const priceRiskIntent =
    combined.includes("expensive") ||
    combined.includes("costly") ||
    combined.includes("repair cost") ||
    combined.includes("big repair") ||
    combined.includes("غالي") ||
    combined.includes("مكلف") ||
    combined.includes("سعر التصليح") ||
    combined.includes("تكلفة");

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
      "multiple brake / ABS / stability clues point to one shared subsystem"
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
      "misfire / rough-idle / combustion pattern"
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
      "air-fuel metering pattern"
    );
  }

  if (
    combined.includes("coolant") ||
    combined.includes("overheating") ||
    combined.includes("running hot") ||
    combined.includes("حرارة") ||
    combined.includes("نقص ماء")
  ) {
    addCluster(
      "cooling_system",
      9,
      "cooling-system pattern"
    );
  }

  if (
    combined.includes("battery") ||
    combined.includes("alternator") ||
    combined.includes("voltage") ||
    combined.includes("charging") ||
    combined.includes("بطارية") ||
    combined.includes("دينمو")
  ) {
    addCluster(
      "charging_voltage",
      8,
      "charging / voltage behavior"
    );
  }

  if (
    combined.includes("air suspension") ||
    combined.includes("ride height") ||
    combined.includes("suspension") ||
    combined.includes("تعليق") ||
    upperCodes.some((c) => c.startsWith("C17") || c.startsWith("C18"))
  ) {
    addCluster(
      "suspension_height_control",
      7,
      "suspension / height-control pattern"
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
      "module communication pattern"
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
      "central ABS / brake control fault path, not just one random sensor",
      10,
      "the code cluster points to one shared brake / ABS subsystem"
    );
    push(
      "ABS actuator, hydraulic pressure unit, or ABS module issue",
      9,
      "multiple brake-control codes often fit a module / actuator / hydraulic path better than separate parts"
    );
    push(
      "shared wiring, connector, ground, or power supply issue affecting the ABS system",
      8,
      "shared electrical path can trigger several related chassis codes"
    );
    push(
      "wheel-speed sensor or sensor circuit problem, but lower priority if multiple central ABS clues exist",
      6,
      "sensor faults remain possible but may be downstream rather than root cause"
    );

    if (upperCodes.includes("C1252") || upperCodes.includes("C1256")) {
      push(
        "hydraulic or actuator-side ABS fault is especially plausible here",
        9,
        "C1252 / C1256 strengthen the ABS actuator / hydraulic direction"
      );
    }

    if (upperCodes.includes("C1210")) {
      push(
        "stability / brake control is reacting to a deeper ABS-side fault",
        7,
        "C1210 can appear as part of a wider ABS / stability chain"
      );
    }
  }

  if (clusterKey === "misfire_combustion") {
    push(
      "ignition weakness such as coil, plug, or coil driver path",
      9,
      "misfire pattern most commonly fits ignition weakness first"
    );
    push(
      "vacuum leak or unmetered air problem",
      8,
      "misfire / rough idle / hesitation often fit an air leak path"
    );
    push(
      "injector or fuel-delivery imbalance",
      7,
      "fuel-side imbalance can mimic ignition misfire"
    );
    if (text.includes("flashing") || text.includes("يهتز بقوة")) {
      push(
        "active severe misfire that can damage the catalytic converter",
        10,
        "strong shake or flashing warning light raises severity"
      );
    }
  }

  if (clusterKey === "air_fuel_metering") {
    push(
      "vacuum leak or intake leak ahead of accurate fuel control",
      9,
      "air-fuel imbalance often starts with unmetered air"
    );
    push(
      "MAF / MAP signal issue or contaminated measurement path",
      7,
      "sensor reading problems can distort fueling"
    );
    push(
      "fuel-pressure or injector imbalance",
      7,
      "fuel side remains a realistic path"
    );
  }

  if (clusterKey === "cooling_system") {
    push(
      "cooling system pressure loss or circulation problem",
      9,
      "heat / coolant behavior fits cooling-system root cause first"
    );
    push(
      "thermostat, trapped air, or water-pump weakness",
      8,
      "common cooling-system branch"
    );
    push(
      "fan control issue if overheating is strongest at idle or traffic",
      7,
      "idle-heavy overheating often shifts toward fan control"
    );
  }

  if (clusterKey === "charging_voltage") {
    push(
      "charging-system weakness from battery, alternator, or poor connections",
      9,
      "voltage-related behavior fits charging path"
    );
    push(
      "ground or terminal connection problem",
      8,
      "shared voltage instability often comes from poor connections"
    );
  }

  if (clusterKey === "suspension_height_control") {
    push(
      "air-suspension compressor, valve block, or ride-height control fault",
      8,
      "ride-height problems often point to a central suspension control path"
    );
    push(
      "height sensor or wiring issue",
      7,
      "sensor-side issue remains possible"
    );
    push(
      "air leak in a bag, line, or suspension circuit",
      8,
      "loss of height often fits air loss"
    );
  }

  if (clusterKey === "network_communication") {
    push(
      "module communication fault caused by voltage, wiring, or failing control module",
      8,
      "network codes often come from shared power, ground, or module issues"
    );
    push(
      "battery / charging instability creating misleading communication faults",
      7,
      "low voltage can cascade into network faults"
    );
  }

  return out;
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
  const codes = uniqueCodesFromMemory(memorySummary, text);
  const clusters = classifyCodeClusters(codes, text, memorySummary);

  const causes = [];

  const pushCause = (label, score, why) => {
    causes.push({ label, score, why });
  };

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
      "ignition misfire from coil, plug, or related ignition weakness",
      8,
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
      "misfire-like behavior without enough proof for ignition only"
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
      8,
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
      7,
      "light repetitive ticking pattern"
    );
  }

  if (combined.includes("squeal") || combined.includes("صرير")) {
    pushCause(
      "belt, pulley, or bearing noise",
      7,
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
      7,
      "charging-related wording"
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
    .slice(0, 5);
}

function buildTests({
  memorySummary = {},
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

  if (
    clusterKey === "abs_brake_stability" ||
    domain === "brakes" ||
    topCause.includes("ABS") ||
    topCause.includes("brake")
  ) {
    pushTest("scan and confirm whether the ABS / brake codes return immediately after clearing");
    pushTest("inspect ABS module, actuator, hydraulic unit, and main connector before replacing random sensors");
    pushTest("check shared power, fuse, ground, and connector condition for the ABS system");
    pushTest("inspect wheel-speed sensor live data only after ruling out the central ABS path");
  }

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

  if (topCause.includes("knock")) {
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

  if (clusterKey === "suspension_height_control") {
    pushTest("inspect ride height on all corners and check whether one side drops more than the others");
    pushTest("check compressor operation, valve block, and visible air leaks");
    pushTest("inspect height-sensor linkage and wiring");
  }

  if (repairs.includes("spark plugs") && topCause.includes("ignition")) {
    pushTest("since plugs were already replaced, focus more on coils, install quality, and related air leak path");
  }

  return dedupe(tests).slice(0, 6);
}

function buildQuestions({
  memorySummary = {},
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

  if (
    clusterKey === "abs_brake_stability" ||
    topCause.includes("ABS") ||
    topCause.includes("brake")
  ) {
    pushQuestion("Is the ABS light or brake warning light on now, and does the pedal feel normal or weak?");
  }

  if (codes.length === 0 && topCause.includes("ignition")) {
    pushQuestion("Are there any check-engine codes right now, or is the light just on without a scan?");
  }

  if (
    symptomsText.includes("rough idle") ||
    symptomsText.includes("misfire")
  ) {
    pushQuestion("Is the shake strongest at idle and does it smooth out when you give it throttle?");
  }

  if (topCause.includes("knock")) {
    pushQuestion("Is the sound a light fast tick, or a deeper knock that gets heavier under load?");
  }

  if (topCause.includes("cooling")) {
    pushQuestion("Does the temperature rise mainly while driving, at idle, or both?");
  }

  if (userIntent.purchaseIntent) {
    pushQuestion("Before buying it, do you know whether these faults are current and active, or were they old stored codes?");
  }

  if (unresolved.includes("fault_codes_unknown")) {
    pushQuestion("If you do not have a scanner yet, tell me whether the check-engine light is steady or flashing.");
  }

  return dedupe(questions).slice(0, 2);
}

function detectSeverity({
  memorySummary = {},
  topCause = "",
  text = "",
  clusterKey = "",
}) {
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
    topCause.includes("true engine knock")
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

function detectDomain(topCause = "", text = "", clusterKey = "") {
  const value = `${String(topCause || "").toLowerCase()} | ${String(
    text || ""
  ).toLowerCase()} | ${String(clusterKey || "").toLowerCase()}`;

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
    combined.includes("scanner screen") ||
    combined.includes("صورة") ||
    combined.includes("عداد") ||
    combined.includes("لوحة") ||
    combined.includes("قراءة من الصورة");

  const audioSignals =
    combined.includes("sound") ||
    combined.includes("noise") ||
    combined.includes("audio") ||
    combined.includes("recording") ||
    combined.includes("صوت") ||
    combined.includes("تسجيل");

  const gpsSignals =
    combined.includes("near me") ||
    combined.includes("nearby") ||
    combined.includes("closest shop") ||
    combined.includes("workshop near") ||
    combined.includes("mechanic near") ||
    combined.includes("اقرب") ||
    combined.includes("بالقرب") ||
    combined.includes("مكاني") ||
    combined.includes("موقعي") ||
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
}) {
  if (
    severity === "urgent" ||
    clusterKey === "abs_brake_stability" ||
    topCause.includes("true engine knock")
  ) {
    return "driving may be unsafe or should be limited until the core fault is checked";
  }

  if (severity === "high") {
    return "the car may still move, but it should not be ignored and should be checked soon";
  }

  if (userIntent?.safetyIntent) {
    return "it does not look like the kind of issue to ignore for long, even if the car still drives";
  }

  return "no immediate severe danger is proven yet, but the fault path still needs confirmation";
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
    topCause.includes("module") ||
    count >= 3
  ) {
    return "this is not a clean pre-purchase picture; it looks more like a negotiation-risk or possible walk-away case unless priced accordingly and properly diagnosed first";
  }

  if (severity === "high") {
    return "this looks like a negotiable issue, but not something to ignore before buying";
  }

  return "this may still be a manageable used-car issue, but it should be verified before purchase";
}

function buildEvidenceSummary({
  memorySummary = {},
  text = "",
  codes = [],
  clusterKey = "",
  mediaHints = {},
}) {
  const summary = [];

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
    summary.push("audio/noise evidence may be present");
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
    text,
    verifiedData,
  });

  const topCause =
    ranked[0]?.label || "general mechanical fault path still needs narrowing";

  const severity = detectSeverity({
    memorySummary,
    topCause,
    text,
    clusterKey: primaryCluster,
  });

  const domain = detectDomain(topCause, text, primaryCluster);

  const tests = buildTests({
    memorySummary,
    topCause,
    domain,
    clusterKey: primaryCluster,
  });

  const questions = buildQuestions({
    memorySummary,
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
RECOMMENDED_TESTS=${JSON.stringify(tests || [])}
MUST_ASK=${JSON.stringify(questions || [])}
SAFETY_ADVICE=${JSON.stringify(safetyAdvice || "")}
PURCHASE_JUDGMENT=${JSON.stringify(purchaseJudgment || "")}
EVIDENCE_SUMMARY=${JSON.stringify(evidenceSummary || [])}
MEDIA_HINTS=${JSON.stringify(mediaHints || {})}
USER_INTENT=${JSON.stringify(userIntent || {})}
SEARCH_QUERY=${JSON.stringify(query || "")}
WORKSHOP_QUERY=${JSON.stringify(workshopQuery || "")}
MEMORY_SUMMARY=${JSON.stringify(memorySummary || {})}

PLANNER_RULES:
- Lead with STRONGEST_HYPOTHESIS first.
- If PRIMARY_CLUSTER exists, treat the case as a unified subsystem diagnosis, not isolated code explanations.
- Do not present all causes as equal.
- Explain why the clues point toward one central fault if that pattern exists.
- Use RECOMMENDED_TESTS to guide the next practical step.
- Use MUST_ASK only if those questions materially improve the next move.
- If CODES contains several related chassis / ABS / module clues, do not answer like a code dictionary.
- If MEDIA_HINTS.imageSignals is true, treat the image as real diagnostic evidence.
- If MEDIA_HINTS.audioSignals is true, treat sound/noise as diagnostic evidence and reference rhythm / load / speed relation when useful.
- If SEARCH_QUERY is present, external search may be used to refine diagnosis or buying risk.
- If WORKSHOP_QUERY is present, GPS / local shop search may be used to find the right nearby specialist.
- If USER_INTENT.purchaseIntent is true, protect the user like a pre-purchase inspector.
- If SAFETY_ADVICE exists, state it briefly and clearly.
- Sound like a real diagnostician, not a generic assistant.
- Prefer the shortest and highest-yield path first.
`.trim();
}
