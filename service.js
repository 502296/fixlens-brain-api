// search.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Cache in memory (fast + cheap)
let CACHE = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadDataOnce() {
  if (CACHE) return CACHE;

  const dataDir = path.join(__dirname, "data");
  const items = [];

  if (!fs.existsSync(dataDir)) {
    CACHE = { items: [] };
    return CACHE;
  }

  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));

  for (const f of files) {
    const full = path.join(dataDir, f);
    const json = safeReadJson(full);
    if (!json) continue;

    // We accept either array JSON or object JSON
    if (Array.isArray(json)) {
      for (const row of json) items.push({ source: f, ...row });
    } else if (typeof json === "object") {
      // if it has a list field, try common ones
      const list =
        json.items || json.issues || json.data || json.rows || json.list;
      if (Array.isArray(list)) {
        for (const row of list) items.push({ source: f, ...row });
      } else {
        items.push({ source: f, ...json });
      }
    }
  }

  CACHE = { items };
  return CACHE;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreItem(queryTokens, item) {
  // Build a searchable text from common fields
  const hay =
    [
      item.title,
      item.name,
      item.symptoms,
      item.description,
      item.problem,
      item.causes,
      item.fix,
      item.solution,
      item.keywords,
      item.tags,
      item.category,
      item.system,
      item.notes,
    ]
      .flat()
      .filter(Boolean)
      .join(" ")
      .toLowerCase() || "";

  if (!hay) return 0;

  let score = 0;
  for (const t of queryTokens) {
    if (hay.includes(t)) score += 2;
  }

  // Bonus if title matches strongly
  const title = String(item.title || item.name || "").toLowerCase();
  for (const t of queryTokens) {
    if (title.includes(t)) score += 3;
  }

  return score;
}

/**
 * ✅ Local data search (no API cost)
 * Returns a short formatted string to feed the model.
 */
export async function performSearch(userText, userLocation = "Global") {
  const enabled = String(process.env.LOCAL_DATA_SEARCH || "true") === "true";
  if (!enabled) return "";

  const q = String(userText || "").trim();
  if (q.length < 2) return "";

  const { items } = loadDataOnce();
  if (!items.length) return "";

  const tokens = tokenize(q).slice(0, 20);
  if (!tokens.length) return "";

  const scored = items
    .map((it) => ({ it, score: scoreItem(tokens, it) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!scored.length) return "";

  // Build compact output (keep it short to reduce tokens)
  const lines = scored.map(({ it, score }, idx) => {
    const title = it.title || it.name || "Issue";
    const symptoms = it.symptoms || it.problem || "";
    const causes = it.causes || "";
    const fix = it.fix || it.solution || "";
    return `#${idx + 1} (${it.source}) ${title}
Symptoms: ${String(symptoms).slice(0, 220)}
Likely causes: ${String(causes).slice(0, 220)}
Suggested checks/fix: ${String(fix).slice(0, 220)}`;
  });

  return `LOCAL_DATA_MATCHES (Location=${userLocation}):
${lines.join("\n\n")}`;
}
