// memoryEngine.js
// FixLens Diagnostic Memory Engine v1.0

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

function sliceRecentUserTexts(history = [], limit = 8) {
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

function extractVehicleFromText(text = "") {
  const raw = String(text || "");
  const lower = raw.toLowerCase();

  const makes = [
    "toyota", "honda", "ford", "chevrolet", "chevy", "gmc", "cadillac",
    "nissan", "hyundai", "kia", "mazda", "subaru", "lexus", "acura",
    "infiniti", "bmw", "mercedes", "mercedes-benz", "audi", "volkswagen",
    "vw", "jeep", "dodge", "chrysler", "ram", "lincoln", "buick",
    "mitsubishi", "volvo", "porsche", "jaguar", "land rover", "tesla"
  ];

  const models = [
    "camry", "corolla", "rav4", "highlander", "civic", "accord", "cr-v",
    "pilot", "f-150", "escape", "explorer", "fusion", "malibu", "silverado",
    "tahoe", "yukon", "altima", "sentra", "rogue", "pathfinder", "elantra",
    "sonata", "tucson", "santa fe", "optima", "sorento", "sportage", "cx-5",
    "cx5", "cx-9", "outback", "forester", "impreza", "wrx", "rx350", "es350",
    "mdx", "tlx", "q50", "x5", "x3", "c300", "e350", "a4", "q5", "jetta",
    "passat", "tiguan", "wrangler", "grand cherokee", "charger", "challenger",
    "durango", "1500", "model 3", "model y", "model s"
  ];

  let make = null;
  let model = null;
  const year = extractYear(raw);

  for (const mk of makes) {
    if (lower.includes(mk)) {
      make = mk;
      break;
    }
  }

  for (const md of models) {
    if (lower.includes(md)) {
      model = md;
      break;
    }
  }

  return {
    year: Number.isFinite(year) ? year : null,
    make: make || null,
    model: model || null,
  };
}

function extractSymptoms(text = "") {
  const lower = String(text || "").toLowerCase();

  const patterns = [
    ["rough idle", ["rough idle", "idle rough", "shaking at idle", "رجفة", "اهتزاز", "هزة", "يرجف"]],
    ["misfire", ["misfire", "تقطيع", "تنتيع", "تفتفة"]],
    ["check engine light", ["check engine", "cel", "لمبة المكينة", "لمبة check", "لمبة تشيك", "لمبة المحرك"]],
    ["overheating", ["overheat", "running hot", "سخونة", "حرارة", "ترتفع الحرارة"]],
    ["coolant loss", ["coolant", "ماء الرديتر", "نقص ماء", "تهريب ماء", "تسريب ماء"]],
    ["oil leak", ["oil leak", "leaking oil", "تهريب زيت", "تسريب زيت"]],
    ["smoke", ["smoke", "دخان"]],
    ["burning smell", ["burning smell", "plastic smell", "رائحة حرق", "ريحة حرق"]],
    ["knocking noise", ["knock", "knocking", "دق", "خبط"]],
    ["ticking noise", ["tick", "ticking", "تك تك", "طقطقة"]],
    ["squeal", ["squeal", "صرير"]],
    ["stalling", ["stall", "stalls", "يطفي", "تطفي"]],
    ["hard start", ["hard start", "long crank", "صعوبة تشغيل", "يتأخر بالتشغيل"]],
    ["battery issue", ["battery", "بطارية"]],
    ["alternator issue", ["alternator", "دينمو"]],
    ["brake issue", ["brake", "brakes", "فرامل"]],
    ["steering issue", ["steering", "دركسون", "ستيرنغ"]],
    ["vibration under acceleration", ["vibration under acceleration", "shake when accelerating", "رجفة مع الدعس"]],
    ["hesitation", ["hesitation", "hesitates", "يتردد", "يختنق"]],
  ];

  const hits = [];

  for (const [label, keys] of patterns) {
    if (keys.some((k) => lower.includes(k.toLowerCase()))) {
      hits.push(label);
    }
  }

  return uniqueStrings(hits).slice(0, 10);
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

function extractPriorRepairs(text = "") {
  const lines = String(text || "")
    .split(/[\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const repairWords = [
    "changed", "replaced", "new", "installed", "cleaned", "fixed",
    "غيرت", "بدلت", "ركبت", "نظفت", "صلحت", "سويت"
  ];

  return uniqueStrings(
    lines.filter((line) =>
      repairWords.some((word) => line.toLowerCase().includes(word))
    )
  ).slice(0, 8);
}

function extractCodes(text = "") {
  const matches = String(text || "").match(/\b[PBCU][0-9]{4}\b/gi) || [];
  return uniqueStrings(matches.map((x) => x.toUpperCase())).slice(0, 6);
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

  return uniqueStrings(out).slice(0, 8);
}

function mergeVehicle(base = {}, next = {}) {
  return {
    year: next.year || base.year || null,
    make: next.make || base.make || null,
    model: next.model || base.model || null,
  };
}

function detectCaseDirection(summary = {}) {
  const symptoms = Array.isArray(summary?.symptoms) ? summary.symptoms : [];
  const joined = symptoms.join(" | ").toLowerCase();

  if (
    joined.includes("misfire") ||
    joined.includes("rough idle") ||
    joined.includes("hesitation")
  ) {
    return "ignition_or_air_fuel";
  }

  if (
    joined.includes("overheating") ||
    joined.includes("coolant")
  ) {
    return "cooling_system";
  }

  if (
    joined.includes("battery issue") ||
    joined.includes("alternator issue")
  ) {
    return "electrical_charging";
  }

  if (joined.includes("brake issue")) return "braking_system";
  if (joined.includes("steering issue")) return "steering_or_suspension";

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
  const userTexts = sliceRecentUserTexts(history, 8);
  const allTexts = [...userTexts, String(text || "").trim(), String(voiceText || "").trim()]
    .filter(Boolean);

  let vehicle = {
    year: null,
    make: null,
    model: null,
  };

  let symptoms = [];
  let priorRepairs = [];
  let codes = [];
  let openPoints = [];
  let tempBehavior = null;
  let loadBehavior = null;

  for (const chunk of allTexts) {
    vehicle = mergeVehicle(vehicle, extractVehicleFromText(chunk));
    symptoms = symptoms.concat(extractSymptoms(chunk));
    priorRepairs = priorRepairs.concat(extractPriorRepairs(chunk));
    codes = codes.concat(extractCodes(chunk));
    openPoints = openPoints.concat(extractQuestionsStillOpen(chunk));

    tempBehavior = tempBehavior || extractTemperatureBehavior(chunk);
    loadBehavior = loadBehavior || extractLoadBehavior(chunk);
  }

  symptoms = uniqueStrings(symptoms).slice(0, 10);
  priorRepairs = uniqueStrings(priorRepairs).slice(0, 8);
  codes = uniqueStrings(codes).slice(0, 6);
  openPoints = uniqueStrings(openPoints).slice(0, 8);

  const summary = {
    vehicle,
    symptoms,
    prior_repairs: priorRepairs,
    fault_codes: codes,
    unresolved_points: openPoints,
    temperature_behavior: tempBehavior,
    load_behavior: loadBehavior,
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
AUDIO_CONTEXT=${JSON.stringify(summary?.audio_context || null)}

MEMORY_RULES:
- Treat this as live case memory.
- Do not repeat steps the user already tried unless there is a reason.
- Use this memory to continue the same diagnosis thread.
- Prefer narrowing the case over restarting it.
`.trim();
}
