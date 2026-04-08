// memoryEngine.js
// FixLens Diagnostic Memory Engine v2.0

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(items = []) {
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

function sliceRecentUserTexts(history = [], limit = 10) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user")
    .slice(-limit)
    .map((item) => String(item?.content || "").trim())
    .filter(Boolean);
}

function extractYear(text = "") {
  const match = String(text || "").match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function detectLanguageLock(text = "", history = []) {
  const combined = [
    ...sliceRecentUserTexts(history, 6),
    String(text || "").trim(),
  ]
    .filter(Boolean)
    .join(" ");

  const hasArabic = /[\u0600-\u06FF]/.test(combined);
  const hasLatin = /[A-Za-z]/.test(combined);

  if (hasArabic && !hasLatin) {
    return {
      language: "ar",
      style: "arabic_locked",
    };
  }

  if (hasArabic && hasLatin) {
    return {
      language: "mixed",
      style: "mixed_locked",
    };
  }

  return {
    language: "en",
    style: "english_locked",
  };
}

function extractVehicleFromText(text = "") {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const makes = [
    ["Toyota", ["toyota", "تويوتا"]],
    ["Honda", ["honda", "هوندا"]],
    ["Ford", ["ford", "فورد"]],
    ["Chevrolet", ["chevrolet", "chevy", "شفر", "شيفروليه", "شفروليه"]],
    ["GMC", ["gmc", "جمس"]],
    ["Cadillac", ["cadillac", "كاديلاك"]],
    ["Nissan", ["nissan", "نيسان"]],
    ["Hyundai", ["hyundai", "هيونداي"]],
    ["Kia", ["kia", "كيا"]],
    ["Mazda", ["mazda", "مازدا"]],
    ["Subaru", ["subaru", "سوبارو"]],
    ["Lexus", ["lexus", "لكزس", "لكسس"]],
    ["Acura", ["acura", "اكورا"]],
    ["Infiniti", ["infiniti", "انفينيتي"]],
    ["BMW", ["bmw", "بي ام", "بي ام دبليو"]],
    ["Mercedes-Benz", ["mercedes", "mercedes-benz", "benz", "مرسيدس", "بنز"]],
    ["Audi", ["audi", "اودي"]],
    ["Volkswagen", ["volkswagen", "vw", "فولكس", "فولكس واغن"]],
    ["Jeep", ["jeep", "جيب"]],
    ["Dodge", ["dodge", "دودج"]],
    ["Chrysler", ["chrysler", "كرايسلر"]],
    ["RAM", ["ram", "رام"]],
    ["Lincoln", ["lincoln", "لينكون"]],
    ["Buick", ["buick", "بويك"]],
    ["Mitsubishi", ["mitsubishi", "ميتسوبيشي"]],
    ["Volvo", ["volvo", "فولفو"]],
    ["Porsche", ["porsche", "بورش"]],
    ["Jaguar", ["jaguar", "جاكوار"]],
    ["Land Rover", ["land rover", "لاند روفر"]],
    ["Tesla", ["tesla", "تسلا"]],
  ];

  const models = [
    ["Camry", ["camry", "كامري"]],
    ["Corolla", ["corolla", "كورولا"]],
    ["RAV4", ["rav4", "rav 4", "راف فور"]],
    ["Highlander", ["highlander", "هايلاندر"]],
    ["Civic", ["civic", "سيفك", "سيفيك"]],
    ["Accord", ["accord", "اكورد", "أكورد"]],
    ["CR-V", ["cr-v", "crv", "سي ار في"]],
    ["Pilot", ["pilot", "بايلوت"]],
    ["F-150", ["f-150", "f150", "اف 150"]],
    ["Escape", ["escape", "اسكيب"]],
    ["Explorer", ["explorer", "اكسبلورر"]],
    ["Fusion", ["fusion", "فيوجن"]],
    ["Malibu", ["malibu", "ماليبو"]],
    ["Silverado", ["silverado", "سيلفرادو"]],
    ["Tahoe", ["tahoe", "تاهو"]],
    ["Yukon", ["yukon", "يوكن"]],
    ["Altima", ["altima", "التيما"]],
    ["Sentra", ["sentra", "سنترا"]],
    ["Rogue", ["rogue", "روغ"]],
    ["Pathfinder", ["pathfinder", "باثفايندر"]],
    ["Elantra", ["elantra", "النترا"]],
    ["Sonata", ["sonata", "سوناتا"]],
    ["Tucson", ["tucson", "توسان"]],
    ["Santa Fe", ["santa fe", "سانتافي"]],
    ["Optima", ["optima", "اوبتيما"]],
    ["Sorento", ["sorento", "سورينتو"]],
    ["Sportage", ["sportage", "سبورتاج"]],
    ["CX-5", ["cx-5", "cx5"]],
    ["CX-9", ["cx-9", "cx9"]],
    ["Outback", ["outback", "اوتباك"]],
    ["Forester", ["forester", "فورستر"]],
    ["Impreza", ["impreza", "امبريزا"]],
    ["WRX", ["wrx"]],
    ["RX", ["rx350", "rx 350", "rx"]],
    ["ES", ["es350", "es 350", "es"]],
    ["MDX", ["mdx"]],
    ["TLX", ["tlx"]],
    ["Q50", ["q50"]],
    ["X5", ["x5"]],
    ["X3", ["x3"]],
    ["C-Class", ["c300", "c250", "c350", "c class"]],
    ["E-Class", ["e350", "e300", "e class"]],
    ["A4", ["a4"]],
    ["Q5", ["q5"]],
    ["Jetta", ["jetta", "جيتا"]],
    ["Passat", ["passat", "باسات"]],
    ["Tiguan", ["tiguan", "تيجوان"]],
    ["Wrangler", ["wrangler", "رانجلر"]],
    ["Grand Cherokee", ["grand cherokee", "جراند شيروكي"]],
    ["Charger", ["charger", "تشارجر"]],
    ["Challenger", ["challenger", "تشالنجر"]],
    ["Durango", ["durango", "دورانجو"]],
    ["1500", ["1500"]],
    ["Model 3", ["model 3"]],
    ["Model Y", ["model y"]],
    ["Model S", ["model s"]],
  ];

  let make = null;
  let model = null;
  const year = extractYear(raw);

  for (const [label, aliases] of makes) {
    if (aliases.some((x) => lower.includes(x.toLowerCase()))) {
      make = label;
      break;
    }
  }

  for (const [label, aliases] of models) {
    if (aliases.some((x) => lower.includes(x.toLowerCase()))) {
      model = label;
      break;
    }
  }

  return {
    year: Number.isFinite(year) ? year : null,
    make: make || null,
    model: model || null,
  };
}

function extractEngineHint(text = "") {
  const lower = String(text || "").toLowerCase();

  const patterns = [
    ["2.4L 4-cylinder", ["2.4", "2.4l", "2.4 liter"]],
    ["2.5L 4-cylinder", ["2.5", "2.5l", "2.5 liter"]],
    ["2.0L turbo", ["2.0 turbo", "2.0t"]],
    ["3.5L V6", ["3.5", "3.5l", "3.5 v6", "v6 3.5"]],
    ["4.0L V6", ["4.0", "4.0l", "4.0 v6"]],
    ["4.6L V8", ["4.6", "4.6l", "4.6 v8"]],
    ["5.7L V8", ["5.7", "5.7l", "5.7 v8"]],
    ["hybrid", ["hybrid", "هايبرد", "هجين"]],
    ["diesel", ["diesel", "ديزل"]],
  ];

  for (const [label, keys] of patterns) {
    if (keys.some((k) => lower.includes(k.toLowerCase()))) {
      return label;
    }
  }

  return null;
}

function extractSymptoms(text = "") {
  const lower = String(text || "").toLowerCase();

  const patterns = [
    ["rough idle", ["rough idle", "idle rough", "shaking at idle", "رجفة", "اهتزاز", "هزة", "يرجف", "على السلانسيه يهتز"]],
    ["misfire", ["misfire", "تقطيع", "تنتيع", "تفتفة", "يفصل"]],
    ["check engine light", ["check engine", "cel", "لمبة المكينة", "لمبة check", "لمبة تشيك", "لمبة المحرك"]],
    ["ABS light", ["abs light", "abs", "لمبة abs", "مانع الانغلاق"]],
    ["brake warning light", ["brake light", "فرامل", "لمبة الفرامل", "brake warning"]],
    ["traction / stability warning", ["traction", "stability", "esp", "vsc", "مانع الانزلاق", "ثبات"]],
    ["overheating", ["overheat", "running hot", "سخونة", "حرارة", "ترتفع الحرارة"]],
    ["coolant loss", ["coolant", "ماء الرديتر", "نقص ماء", "تهريب ماء", "تسريب ماء"]],
    ["oil leak", ["oil leak", "leaking oil", "تهريب زيت", "تسريب زيت"]],
    ["smoke", ["smoke", "دخان"]],
    ["burning smell", ["burning smell", "plastic smell", "رائحة حرق", "ريحة حرق"]],
    ["knocking noise", ["knock", "knocking", "دق", "خبط"]],
    ["ticking noise", ["tick", "ticking", "تك تك", "طقطقة"]],
    ["squeal", ["squeal", "صرير"]],
    ["stalling", ["stall", "stalls", "يطفي", "تطفي", "يفصل"]],
    ["hard start", ["hard start", "long crank", "صعوبة تشغيل", "يتأخر بالتشغيل"]],
    ["battery issue", ["battery", "بطارية"]],
    ["alternator issue", ["alternator", "دينمو"]],
    ["brake issue", ["brake", "brakes", "فرامل", "دعسة الفرامل"]],
    ["weak brake pedal", ["soft pedal", "weak brake", "pedal goes down", "دعسة الفرامل ضعيفة", "الفرامل ضعيفة"]],
    ["steering issue", ["steering", "دركسون", "ستيرنغ", "ثقل دركسون"]],
    ["vibration under acceleration", ["vibration under acceleration", "shake when accelerating", "رجفة مع الدعس", "يهتز مع الدعس"]],
    ["hesitation", ["hesitation", "hesitates", "يتردد", "يختنق"]],
    ["loss of power", ["loss of power", "weak acceleration", "ضعف عزم", "ضعف سحب"]],
    ["suspension height issue", ["ride height", "air suspension", "تعليق", "هبوط جهة", "نزلت السيارة"]],
    ["communication fault behavior", ["communication", "network", "module", "can bus", "شبكة", "وحدة تحكم"]],
  ];

  const hits = [];

  for (const [label, keys] of patterns) {
    if (keys.some((k) => lower.includes(k.toLowerCase()))) {
      hits.push(label);
    }
  }

  return uniqueStrings(hits).slice(0, 14);
}

function extractTemperatureBehavior(text = "") {
  const lower = String(text || "").toLowerCase();

  if (
    lower.includes("cold start") ||
    lower.includes("when cold") ||
    lower.includes("cold engine") ||
    lower.includes("بارد") ||
    lower.includes("وهو بارد")
  ) {
    return "worse_when_cold";
  }

  if (
    lower.includes("after warm up") ||
    lower.includes("when hot") ||
    lower.includes("after driving") ||
    lower.includes("بعد ما تحمى") ||
    lower.includes("وهي حارة") ||
    lower.includes("بعد المشي")
  ) {
    return "worse_when_hot";
  }

  return null;
}

function extractLoadBehavior(text = "") {
  const lower = String(text || "").toLowerCase();

  if (
    lower.includes("at idle") ||
    lower.includes("idle") ||
    lower.includes("واقف") ||
    lower.includes("على الايدل") ||
    lower.includes("على السلانسيه")
  ) {
    return "idle_related";
  }

  if (
    lower.includes("under load") ||
    lower.includes("when accelerating") ||
    lower.includes("with throttle") ||
    lower.includes("مع الدعس") ||
    lower.includes("وقت الدعس")
  ) {
    return "load_related";
  }

  return null;
}

function extractSpeedBehavior(text = "") {
  const lower = String(text || "").toLowerCase();

  if (
    lower.includes("at highway speed") ||
    lower.includes("on highway") ||
    lower.includes("high speed") ||
    lower.includes("على الخط") ||
    lower.includes("على السرعة")
  ) {
    return "higher_speed_related";
  }

  if (
    lower.includes("low speed") ||
    lower.includes("slow speed") ||
    lower.includes("بطيء") ||
    lower.includes("عند السرعات الواطية")
  ) {
    return "low_speed_related";
  }

  return null;
}

function extractPriorRepairs(text = "") {
  const lines = String(text || "")
    .split(/[\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const repairWords = [
    "changed", "replaced", "new", "installed", "cleaned", "fixed", "repaired",
    "غيرت", "بدلت", "ركبت", "نظفت", "صلحت", "سويت", "بدلنا", "تم تغيير"
  ];

  return uniqueStrings(
    lines.filter((line) =>
      repairWords.some((word) => line.toLowerCase().includes(word))
    )
  ).slice(0, 10);
}

function extractCodes(text = "") {
  const matches = String(text || "").match(/\b([PBCU][0-9]{4}|[A-Z][0-9]{4})\b/gi) || [];
  return uniqueStrings(matches.map((x) => x.toUpperCase())).slice(0, 10);
}

function extractQuestionsStillOpen(text = "") {
  const lower = String(text || "").toLowerCase();
  const out = [];

  if (
    lower.includes("don't know the code") ||
    lower.includes("no scanner") ||
    lower.includes("ما عندي سكانر") ||
    lower.includes("ما اعرف الكود")
  ) {
    out.push("fault_codes_unknown");
  }

  if (
    lower.includes("didn't check coils") ||
    lower.includes("coil unknown") ||
    lower.includes("ما فحصت الكويلات")
  ) {
    out.push("coil_status_unknown");
  }

  if (
    lower.includes("didn't check plugs") ||
    lower.includes("plug unknown") ||
    lower.includes("ما فحصت البواجي")
  ) {
    out.push("plug_status_unknown");
  }

  if (
    lower.includes("not sure if old code") ||
    lower.includes("stored code") ||
    lower.includes("ما اعرف اذا قديم") ||
    lower.includes("قديم او جديد")
  ) {
    out.push("code_age_unknown");
  }

  if (
    lower.includes("i don't know if the brake feels weak") ||
    lower.includes("ما ركزت على الفرامل")
  ) {
    out.push("brake_feel_unknown");
  }

  return uniqueStrings(out).slice(0, 10);
}

function extractPurchaseIntent(text = "") {
  const lower = String(text || "").toLowerCase();

  return (
    lower.includes("should i buy") ||
    lower.includes("worth buying") ||
    lower.includes("before i buy") ||
    lower.includes("buy this car") ||
    lower.includes("pre purchase") ||
    lower.includes("pre-purchase") ||
    lower.includes("اشتريها") ||
    lower.includes("اشتري") ||
    lower.includes("تنصحني اشتري") ||
    lower.includes("قبل لا اشتري") ||
    lower.includes("افحصها قبل الشراء")
  );
}

function extractSafetyIntent(text = "") {
  const lower = String(text || "").toLowerCase();

  return (
    lower.includes("safe to drive") ||
    lower.includes("can i drive it") ||
    lower.includes("is it safe") ||
    lower.includes("هل امشي بيها") ||
    lower.includes("هل أسوقها") ||
    lower.includes("آمنة") ||
    lower.includes("أقدر أمشي")
  );
}

function extractNearbyIntent(text = "") {
  const lower = String(text || "").toLowerCase();

  return (
    lower.includes("near me") ||
    lower.includes("nearby") ||
    lower.includes("closest mechanic") ||
    lower.includes("closest shop") ||
    lower.includes("shop near") ||
    lower.includes("اقرب") ||
    lower.includes("بالقرب") ||
    lower.includes("قريب مني") ||
    lower.includes("مكاني") ||
    lower.includes("gps") ||
    lower.includes("zip")
  );
}

function extractMediaIntent(text = "", voiceText = "", audioType = "none") {
  const combined = `${String(text || "").toLowerCase()} | ${String(voiceText || "").toLowerCase()}`;

  return {
    image_case:
      combined.includes("photo") ||
      combined.includes("picture") ||
      combined.includes("image") ||
      combined.includes("dashboard") ||
      combined.includes("scanner screen") ||
      combined.includes("صورة") ||
      combined.includes("عداد") ||
      combined.includes("لوحة"),
    audio_case:
      audioType && audioType !== "none"
        ? true
        : combined.includes("sound") ||
          combined.includes("noise") ||
          combined.includes("recording") ||
          combined.includes("audio") ||
          combined.includes("صوت") ||
          combined.includes("تسجيل"),
  };
}

function extractLocationHints(text = "") {
  const lower = String(text || "").toLowerCase();
  const out = [];

  const zipMatch = lower.match(/\b\d{5}\b/g) || [];
  out.push(...zipMatch);

  const cityHints = [
    "louisville",
    "lexington",
    "new york",
    "brooklyn",
    "queens",
    "manhattan",
    "bronx",
    "baghdad",
    "basra",
    "erbil",
    "dearborn",
    "detroit",
    "houston",
    "dallas",
    "miami",
    "orlando",
    "chicago",
    "los angeles",
    "san diego",
    "seattle",
    "atlanta",
  ];

  for (const city of cityHints) {
    if (lower.includes(city)) out.push(city);
  }

  return uniqueStrings(out).slice(0, 6);
}

function mergeVehicle(base = {}, next = {}) {
  return {
    year: next.year || base.year || null,
    make: next.make || base.make || null,
    model: next.model || base.model || null,
    engine: next.engine || base.engine || null,
  };
}

function detectCaseDirection(summary = {}) {
  const symptoms = Array.isArray(summary?.symptoms) ? summary.symptoms : [];
  const codes = Array.isArray(summary?.fault_codes) ? summary.fault_codes : [];
  const joined = symptoms.join(" | ").toLowerCase();
  const joinedCodes = codes.join(" | ").toUpperCase();

  if (
    joined.includes("ABS light".toLowerCase()) ||
    joined.includes("brake warning light".toLowerCase()) ||
    joined.includes("traction / stability warning".toLowerCase()) ||
    joined.includes("brake issue".toLowerCase()) ||
    codes.some((c) => c.startsWith("C12") || c.startsWith("C13"))
  ) {
    return "abs_brake_stability";
  }

  if (
    joined.includes("misfire") ||
    joined.includes("rough idle") ||
    joined.includes("hesitation") ||
    joined.includes("loss of power") ||
    joinedCodes.includes("P03")
  ) {
    return "ignition_or_air_fuel";
  }

  if (
    joined.includes("overheating") ||
    joined.includes("coolant loss")
  ) {
    return "cooling_system";
  }

  if (
    joined.includes("battery issue") ||
    joined.includes("alternator issue") ||
    codes.some((c) => c.startsWith("U0") || c.startsWith("U1"))
  ) {
    return "electrical_or_voltage";
  }

  if (joined.includes("suspension height issue")) {
    return "suspension_height_control";
  }

  if (
    joined.includes("knocking noise") ||
    joined.includes("ticking noise") ||
    joined.includes("squeal")
  ) {
    return "noise_path_pending";
  }

  return "general_diagnosis";
}

export function buildDiagnosticMemory({
  text = "",
  history = [],
  voiceText = "",
  audioType = "none",
}) {
  const userTexts = sliceRecentUserTexts(history, 10);
  const allTexts = [...userTexts, String(text || "").trim(), String(voiceText || "").trim()]
    .filter(Boolean);

  let vehicle = {
    year: null,
    make: null,
    model: null,
    engine: null,
  };

  let symptoms = [];
  let priorRepairs = [];
  let codes = [];
  let openPoints = [];
  let tempBehavior = null;
  let loadBehavior = null;
  let speedBehavior = null;
  let purchaseIntent = false;
  let safetyIntent = false;
  let nearbyIntent = false;
  let locationHints = [];
  let caseTags = [];
  let firstUserProblem = null;

  for (const chunk of allTexts) {
    const extractedVehicle = extractVehicleFromText(chunk);
    const engineHint = extractEngineHint(chunk);

    vehicle = mergeVehicle(vehicle, {
      ...extractedVehicle,
      engine: engineHint || null,
    });

    const newSymptoms = extractSymptoms(chunk);
    symptoms = symptoms.concat(newSymptoms);

    if (!firstUserProblem && newSymptoms.length > 0) {
      firstUserProblem = newSymptoms[0];
    }

    priorRepairs = priorRepairs.concat(extractPriorRepairs(chunk));
    codes = codes.concat(extractCodes(chunk));
    openPoints = openPoints.concat(extractQuestionsStillOpen(chunk));

    tempBehavior = tempBehavior || extractTemperatureBehavior(chunk);
    loadBehavior = loadBehavior || extractLoadBehavior(chunk);
    speedBehavior = speedBehavior || extractSpeedBehavior(chunk);

    if (extractPurchaseIntent(chunk)) purchaseIntent = true;
    if (extractSafetyIntent(chunk)) safetyIntent = true;
    if (extractNearbyIntent(chunk)) nearbyIntent = true;

    locationHints = locationHints.concat(extractLocationHints(chunk));

    const media = extractMediaIntent(chunk, voiceText, audioType);
    if (media.image_case) caseTags.push("image_case");
    if (media.audio_case) caseTags.push("audio_case");
  }

  const languageLock = detectLanguageLock(text, history);

  symptoms = uniqueStrings(symptoms).slice(0, 14);
  priorRepairs = uniqueStrings(priorRepairs).slice(0, 10);
  codes = uniqueStrings(codes).slice(0, 10);
  openPoints = uniqueStrings(openPoints).slice(0, 10);
  locationHints = uniqueStrings(locationHints).slice(0, 6);
  caseTags = uniqueStrings(caseTags).slice(0, 10);

  if (purchaseIntent) caseTags.push("purchase_case");
  if (safetyIntent) caseTags.push("safety_case");
  if (nearbyIntent) caseTags.push("nearby_case");

  caseTags = uniqueStrings(caseTags);

  const summary = {
    vehicle,
    symptoms,
    prior_repairs: priorRepairs,
    fault_codes: codes,
    unresolved_points: openPoints,
    temperature_behavior: tempBehavior,
    load_behavior: loadBehavior,
    speed_behavior: speedBehavior,
    purchase_intent: purchaseIntent,
    safety_intent: safetyIntent,
    nearby_intent: nearbyIntent,
    location_hints: locationHints,
    first_user_problem: firstUserProblem,
    language_lock: languageLock,
    case_tags: caseTags,
    audio_context:
      audioType && audioType !== "none"
        ? {
            audio_type: audioType,
            transcript_used: Boolean(String(voiceText || "").trim()),
          }
        : null,
  };

  return {
    current_case_summary: summary,
    case_direction: detectCaseDirection(summary),
    memory_text: buildDiagnosticMemoryText(summary),
  };
}

export function buildDiagnosticMemoryText(summary = {}) {
  return `
DIAGNOSTIC_MEMORY:
VEHICLE=${JSON.stringify(summary?.vehicle || {})}
SYMPTOMS=${JSON.stringify(summary?.symptoms || [])}
PRIOR_REPAIRS=${JSON.stringify(summary?.prior_repairs || [])}
FAULT_CODES=${JSON.stringify(summary?.fault_codes || [])}
UNRESOLVED_POINTS=${JSON.stringify(summary?.unresolved_points || [])}
TEMPERATURE_BEHAVIOR=${JSON.stringify(summary?.temperature_behavior || null)}
LOAD_BEHAVIOR=${JSON.stringify(summary?.load_behavior || null)}
SPEED_BEHAVIOR=${JSON.stringify(summary?.speed_behavior || null)}
PURCHASE_INTENT=${JSON.stringify(summary?.purchase_intent || false)}
SAFETY_INTENT=${JSON.stringify(summary?.safety_intent || false)}
NEARBY_INTENT=${JSON.stringify(summary?.nearby_intent || false)}
LOCATION_HINTS=${JSON.stringify(summary?.location_hints || [])}
FIRST_USER_PROBLEM=${JSON.stringify(summary?.first_user_problem || null)}
LANGUAGE_LOCK=${JSON.stringify(summary?.language_lock || {})}
CASE_TAGS=${JSON.stringify(summary?.case_tags || [])}
AUDIO_CONTEXT=${JSON.stringify(summary?.audio_context || null)}

MEMORY_RULES:
- Treat this as live case memory.
- Keep the user's language locked from the first clear language signal unless they explicitly switch.
- Do not repeat steps the user already tried unless there is a reason.
- Use this memory to continue the same diagnosis thread.
- Prefer narrowing the case over restarting it.
- If PURCHASE_INTENT is true, reason like a protective pre-purchase inspector.
- If SAFETY_INTENT is true, answer the driving-safety question directly.
- If NEARBY_INTENT is true, preserve location hints for GPS / shop search.
- If CASE_TAGS includes image_case or audio_case, treat those media types as real evidence in the same case.
`.trim();
}
