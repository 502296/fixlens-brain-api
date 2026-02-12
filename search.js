// search.js — Local verified search using /data JSON files (no web by default)
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// Load all json files into memory once
let KB = [];
try {
  if (fs.existsSync(DATA_DIR)) {
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const p = path.join(DATA_DIR, f);
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        KB.push(...parsed.map((x) => ({ ...x, __source: f })));
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.items)) KB.push(...parsed.items.map((x) => ({ ...x, __source: f })));
        else KB.push({ ...parsed, __source: f });
      }
    }
  }
} catch (e) {
  console.error("KB load error:", e?.message || e);
  KB = [];
}

function toText(record) {
  const fields = [
    record.title,
    record.name,
    record.symptom,
    record.symptoms,
    record.problem,
    record.description,
    record.causes,
    record.checks,
    record.steps,
    record.tags,
  ];

  let s = "";
  for (const v of fields) {
    if (!v) continue;
    if (Array.isArray(v)) s += " " + v.join(" ");
    else if (typeof v === "object") s += " " + JSON.stringify(v);
    else s += " " + String(v);
  }
  if (!s.trim()) s = JSON.stringify(record);
  return s.toLowerCase();
}

function normalizeQuery(q) {
  return String(q || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMatch(query, text) {
  const q = normalizeQuery(query);
  if (!q) return 0;

  const tokens = q.split(" ").filter(Boolean);
  if (!tokens.length) return 0;

  let score = 0;

  // phrase bonus
  if (q.length >= 6 && text.includes(q)) score += 6;

  for (const t of tokens) {
    if (t.length < 2) continue;
    if (text.includes(t)) score += 2;
    if (t.length >= 4 && text.includes(" " + t + " ")) score += 1;
  }
  return score;
}

export async function performSearch(userQuery, userLocation, opts = {}) {
  const { maxResults = 3 } = opts;

  const q = normalizeQuery(userQuery);
  if (!q || q.length < 2) return { verified_data: [], verified_workshops: [] };

  const scored = KB
    .map((r) => {
      const t = toText(r);
      const s = scoreMatch(q, t);
      return { r, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxResults);

  const verified_data = scored.map(({ r, s }) => {
    const title = r.title || r.name || r.problem || "Verified item";
    const causes = r.causes || r.cause || "";
    const steps = r.steps || r.action_steps || r.actions || "";
    const tags = r.tags || r.category || "";
    return {
      title: String(title),
      score: s,
      source: r.__source || "data",
      causes,
      steps,
      tags,
    };
  });

  // Workshops: by default none (no web). We'll add web later for Pro.
  const verified_workshops = [];

  return { verified_data, verified_workshops };
}
