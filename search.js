// search.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================
// ✅ Load + cache local JSON data (once)
// =====================
const DATA_DIR = path.join(__dirname, "data");

// We'll keep: { fileName: jsonObject }
let DATA_CACHE = null;

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function loadAllData() {
  if (DATA_CACHE) return DATA_CACHE;

  const out = {};
  if (!fs.existsSync(DATA_DIR)) {
    console.warn("DATA_DIR not found:", DATA_DIR);
    DATA_CACHE = out;
    return DATA_CACHE;
  }

  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const full = path.join(DATA_DIR, f);
    const raw = fs.readFileSync(full, "utf8");
    const json = safeJsonParse(raw, null);
    if (json) out[f] = json;
  }

  DATA_CACHE = out;
  return DATA_CACHE;
}

// =====================
// ✅ Helpers
// =====================
function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s) {
  const t = normalize(s);
  if (!t) return [];
  // keep short tokens too (e.g. "ev", "vvt") but drop 1-char noise
  return t.split(" ").filter((w) => w.length >= 2);
}

function flattenStrings(obj, limit = 6000) {
  // Collect strings from any JSON shape, but cap to keep speed
  const acc = [];
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null) continue;

    if (typeof cur === "string") {
      acc.push(cur);
    } else if (typeof cur === "number" || typeof cur === "boolean") {
      acc.push(String(cur));
    } else if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) stack.push(cur[i]);
    } else if (typeof cur === "object") {
      for (const k of Object.keys(cur)) {
        stack.push(cur[k]);
      }
    }

    if (acc.join(" ").length > limit) break;
  }
  return acc.join(" ");
}

function scoreText(queryTokens, text) {
  if (!text) return 0;
  const hay = normalize(text);
  let score = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    if (hay.includes(tok)) score += 1;
  }
  return score;
}

function pickCategoryFiles(query) {
  const q = normalize(query);

  // Map intents to files in /data
  const rules = [
    { match: ["diesel", "dpf", "adblue", "def", "egr", "turbo diesel"], files: ["diesel_engine.json", "diesel_aftertreatment.json"] },
    { match: ["ev", "electric", "battery", "inverter", "charging", "hybrid"], files: ["hybrid_ev.json", "electrical.json", "network_can.json"] },
    { match: ["abs", "brake", "braking"], files: ["brakes.json", "adas.json"] },
    { match: ["airbag", "srs"], files: ["airbags_srs.json"] },
    { match: ["coolant", "overheat", "radiator", "thermostat"], files: ["cooling.json", "hvac.json", "heavy_duty_cooling.json"] },
    { match: ["transmission", "gear", "shift"], files: ["transmission.json", "driveline.json"] },
    { match: ["suspension", "steering", "alignment"], files: ["suspension.json"] },
    { match: ["fuel", "injector", "pump", "pressure"], files: ["fuel.json", "engine.json", "diesel_engine.json"] },
    { match: ["can", "network", "u0100", "communication"], files: ["network_can.json", "electrical.json"] },
  ];

  const chosen = new Set(["auto_common_issues.json", "engine.json", "electrical.json"]); // good defaults

  for (const r of rules) {
    if (r.match.some((m) => q.includes(m))) {
      r.files.forEach((f) => chosen.add(f));
    }
  }

  return [...chosen];
}

function summarizeMatch(obj, maxLen = 500) {
  // Return a short summary from the object
  const raw = flattenStrings(obj, 2000);
  const clean = raw.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen).trim() + "…";
}

// =====================
// ✅ Main: performSearch (local-first)
// =====================
export async function performSearch(userQuery, userLocation = "Global") {
  const data = loadAllData();
  const queryTokens = tokenize(userQuery);
  if (queryTokens.length === 0) return "";

  const filesToScan = pickCategoryFiles(userQuery);

  const hits = [];

  for (const file of filesToScan) {
    const json = data[file];
    if (!json) continue;

    // If JSON is array -> each item is candidate
    if (Array.isArray(json)) {
      for (const item of json) {
        const text = flattenStrings(item, 2500);
        const s = scoreText(queryTokens, text);
        if (s >= 2) {
          hits.push({ file, score: s, item });
        }
      }
    } else {
      // object
      const text = flattenStrings(json, 6000);
      const s = scoreText(queryTokens, text);
      if (s >= 2) {
        hits.push({ file, score: s, item: json });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);

  // Build a compact result (cap count + length)
  const top = hits.slice(0, 6);

  if (top.length === 0) return "";

  let out = `LOCAL_DATA_MATCHES (Location: ${userLocation})\n`;
  out += `Query: ${userQuery}\n`;

  for (let i = 0; i < top.length; i++) {
    const h = top[i];
    out += `\n#${i + 1} [${h.file}] score=${h.score}\n`;
    out += summarizeMatch(h.item, 520);
  }

  // Hard cap
  if (out.length > 4500) out = out.slice(0, 4500) + "…";
  return out;
}
