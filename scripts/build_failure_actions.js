import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

const CAUSE_KEYS_PATH = path.join(DATA_DIR, "cause_keys.json");
const OUTPUT_PATH = path.join(DATA_DIR, "failure_actions.json");

function readJson(p) {
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function normalizeRisk(r) {
  const v = String(r || "").toLowerCase().trim();
  if (["low", "medium", "high"].includes(v)) return v;
  return "medium";
}

/**
 * English-only defaults. Model will localize later via LOCALE.
 */
function defaultsFor(risk = "medium") {
  const r = normalizeRisk(risk);

  const base = {
    actions: [
      "Confirm whether the symptom follows RPM (while parked) or follows road speed (while driving).",
      "Note when it happens: cold start only, warm only, or both.",
      "Avoid hard acceleration until the cause is confirmed."
    ],
    stop_now_if: [],
    ignore_risk: "If ignored, the issue may worsen and lead to higher repair cost or safety risk."
  };

  if (r === "low") {
    base.ignore_risk =
      "Usually low risk, but monitor for changes in noise, performance, or warning lights.";
    return base;
  }

  if (r === "high") {
    base.actions = [
      "Limit driving to only what is necessary until inspected.",
      "Confirm whether it gets worse under load vs coasting and whether it follows RPM while parked.",
      "If it worsens quickly, stop and inspect before continuing."
    ];
    base.stop_now_if = uniq([
      "A warning light appears related to oil pressure, overheating, brakes, or charging.",
      "The symptom becomes suddenly louder or is paired with power loss or strong vibration."
    ]);
    base.ignore_risk =
      "High-risk condition: delaying diagnosis can cause rapid damage or create a safety hazard.";
    return base;
  }

  // medium
  base.stop_now_if = uniq([
    "Any warning light appears and the symptom worsens.",
    "The sound becomes harsh, deep, or is paired with noticeable power loss."
  ]);

  return base;
}

function loadCauseKeys() {
  const raw = readJson(CAUSE_KEYS_PATH);

  if (Array.isArray(raw)) {
    return raw
      .filter((x) => x && x.id)
      .map((x) => ({
        id: String(x.id),
        risk_level: x.risk_level || x.risk || x.riskLevel || "medium"
      }));
  }

  // If someone stored it as an object map { id: {...} }
  if (raw && typeof raw === "object") {
    return Object.entries(raw).map(([id, meta]) => ({
      id: String(id),
      risk_level: meta?.risk_level || meta?.risk || meta?.riskLevel || "medium"
    }));
  }

  throw new Error("Unsupported cause_keys.json format");
}

function main() {
  if (!fs.existsSync(CAUSE_KEYS_PATH)) {
    throw new Error("cause_keys.json not found in /data");
  }

  const causeKeys = loadCauseKeys();
  const out = [];

  for (const ck of causeKeys) {
    const d = defaultsFor(ck.risk_level);
    out.push({
      id: ck.id,
      actions: d.actions,
      stop_now_if: d.stop_now_if,
      ignore_risk: d.ignore_risk
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✅ failure_actions.json generated: ${out.length} items`);
}

main();
