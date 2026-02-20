import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

const CAUSE_KEYS_PATH = path.join(DATA_DIR, "cause_keys.json");
const EXISTING_FAILURE_ACTIONS_PATH = path.join(DATA_DIR, "failure_actions.json"); // optional
const OUTPUT_PATH = path.join(DATA_DIR, "failure_actions.json");

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function normalizeRisk(r) {
  const v = String(r || "").toLowerCase().trim();
  if (["low", "medium", "high"].includes(v)) return v;
  return "medium";
}

function normalizeCategory(c) {
  const v = String(c || "").toLowerCase().trim();
  const allowed = [
    "engine_noise",
    "brakes",
    "steering",
    "electrical",
    "cooling",
    "transmission",
    "suspension",
    "other",
  ];
  if (allowed.includes(v)) return v;
  return "other";
}

/**
 * These defaults are English-only and will later be localized by the model.
 * Keep them practical and safe.
 */
function defaultsFor(category, risk) {
  const r = normalizeRisk(risk);
  const c = normalizeCategory(category);

  const base = {
    actions: [
      "Confirm whether the symptom follows RPM (while parked) or follows road speed (while driving).",
      "Note when it happens: cold start only, warm only, or both.",
      "Avoid hard acceleration until the cause is confirmed."
    ],
    stop_now_if: [],
    ignore_risk: "If ignored, the issue may worsen and lead to higher repair cost or safety risk."
  };

  // Category-specific defaults
  if (c === "brakes") {
    base.actions = [
      "Test at low speed in a safe area: does the sound appear only when braking?",
      "Check brake feel: pedal firmness, pulling to one side, or vibration.",
      "Inspect pad thickness/rotor condition as soon as possible."
    ];
    base.stop_now_if = uniq([
      "Any grinding while braking.",
      "Brake pedal becomes very hard/very soft, or stopping distance increases noticeably."
    ]);
    base.ignore_risk = "Brake issues can quickly become a direct safety risk and may damage rotors/calipers.";
    return base;
  }

  if (c === "steering") {
    base.actions = [
      "At idle, gently turn the steering wheel: does the noise change with steering input?",
      "Check for looseness: steering play, clunks over bumps, or wandering.",
      "Inspect steering linkage/boots and get alignment checked after repairs."
    ];
    base.stop_now_if = uniq([
      "Steering becomes loose, binds, or control feels unsafe.",
      "Clunk becomes violent or wheel feels unstable."
    ]);
    base.ignore_risk = "Steering faults can lead to loss of control if they progress.";
    return base;
  }

  if (c === "cooling") {
    base.actions = [
      "Watch temperature gauge: any rise above normal is a priority.",
      "Check coolant level only when the engine is cool.",
      "Inspect for leaks, fan operation, and belt-driven pump noises."
    ];
    base.stop_now_if = uniq([
      "Temperature climbs above normal or warning light appears.",
      "Coolant leak becomes heavy or steam is observed (only if user reported)."
    ]);
    base.ignore_risk = "Overheating can cause severe engine damage quickly.";
    return base;
  }

  if (c === "electrical") {
    base.actions = [
      "Check for warning lights: battery, charging, ABS, traction, or engine light.",
      "Note if the symptom changes with electrical load (lights, defrost, blower).",
      "Verify battery terminals are tight and free of corrosion."
    ];
    base.stop_now_if = uniq([
      "Battery/charging warning with stalling or severe voltage instability."
    ]);
    base.ignore_risk = "Charging/electrical faults can lead to stalling and no-start situations.";
    return base;
  }

  if (c === "transmission") {
    base.actions = [
      "Note which gear/speed range triggers it and whether it changes on throttle vs coast.",
      "Watch for slipping, delayed engagement, or harsh shifts.",
      "Check fluid level/condition if the vehicle allows a proper check."
    ];
    base.stop_now_if = uniq([
      "Sudden loss of drive, severe slipping, or strong shudder with warning lights."
    ]);
    base.ignore_risk = "Transmission issues can escalate quickly and cause loss of drive.";
    return base;
  }

  if (c === "suspension") {
    base.actions = [
      "Test on a small bump at low speed: does it clunk/rattle consistently?",
      "Inspect tires for uneven wear (cupping/scalloping) and check tire pressure.",
      "Check common wear points: sway links, bushings, ball joints."
    ];
    base.stop_now_if = uniq([
      "Wheel feels loose, severe vibration, or vehicle feels unstable."
    ]);
    base.ignore_risk = "Worn suspension components can worsen handling and tire wear; severe play can be unsafe.";
    return base;
  }

  // engine_noise / other
  if (c === "engine_noise") {
    base.actions = [
      "Confirm if the sound follows RPM while stationary (Park/Neutral).",
      "Identify heat relation: cold-only vs warm-only vs both.",
      "Avoid high RPM and heavy load until confirmed."
    ];
    base.stop_now_if = uniq([
      "Oil pressure warning appears or the noise becomes a deep knock under load.",
      "Noise becomes suddenly loud with power loss."
    ]);
    base.ignore_risk = "Some engine noises can indicate rapid internal wear; delaying diagnosis can cause major damage.";
    return base;
  }

  // Risk tuning
  if (r === "high") {
    base.stop_now_if = uniq(base.stop_now_if.concat([
      "The symptom becomes suddenly worse within minutes/hours."
    ]));
    base.actions = uniq([
      ...base.actions.slice(0, 2),
      "Limit driving to only what is necessary until inspected."
    ]);
  } else if (r === "low") {
    base.ignore_risk = "Usually a low-risk issue, but monitor for changes in noise, performance, or warning lights.";
  }

  return base;
}

function toMapById(arr) {
  const m = new Map();
  for (const x of Array.isArray(arr) ? arr : []) {
    if (!x || !x.id) continue;
    m.set(String(x.id), x);
  }
  return m;
}

function validateItem(item) {
  if (!item || !item.id) return false;
  if (!Array.isArray(item.actions) || item.actions.length < 1) return false;
  if (!Array.isArray(item.stop_now_if)) return false;
  if (typeof item.ignore_risk !== "string" || !item.ignore_risk.trim()) return false;
  return true;
}

/**
 * cause_keys.json expected shapes supported:
 * 1) Array of { id, category?, risk?, ... }
 * 2) Object map { "id": { category?, risk?, ... }, ... }
 */
function loadCauseKeys() {
  const raw = readJsonSafe(CAUSE_KEYS_PATH, null);
  if (!raw) throw new Error("cause_keys.json not found or invalid JSON");

  if (Array.isArray(raw)) {
    return raw
      .filter((x) => x && x.id)
      .map((x) => ({
        id: String(x.id),
        category: x.category || x.symptom_category || x.cat || "other",
        risk: x.risk || x.risk_level || "medium",
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([id, meta]) => ({
      id: String(id),
      category: meta?.category || meta?.symptom_category || meta?.cat || "other",
      risk: meta?.risk || meta?.risk_level || "medium",
    }));
  }

  throw new Error("Unsupported cause_keys.json format");
}

function main() {
  const causeKeys = loadCauseKeys(); // source of truth
  const existing = readJsonSafe(EXISTING_FAILURE_ACTIONS_PATH, []);
  const existingMap = toMapById(existing);

  const output = [];

  for (const ck of causeKeys) {
    const id = ck.id;
    const found = existingMap.get(id);

    // if there is an existing item, keep it but normalize structure
    if (found && validateItem(found)) {
      output.push({
        id,
        actions: uniq(found.actions.map(String)),
        stop_now_if: uniq((found.stop_now_if || []).map(String)),
        ignore_risk: String(found.ignore_risk || "").trim() || defaultsFor(ck.category, ck.risk).ignore_risk
      });
      continue;
    }

    // else generate default by category/risk
    const d = defaultsFor(ck.category, ck.risk);
    output.push({
      id,
      actions: d.actions,
      stop_now_if: d.stop_now_if,
      ignore_risk: d.ignore_risk
    });
  }

  // Ensure deterministic order
  output.sort((a, b) => a.id.localeCompare(b.id));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  console.log(`✅ failure_actions.json generated: ${output.length} items`);
}

main();
