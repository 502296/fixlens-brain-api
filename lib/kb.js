

On Fri, Jan 2, 2026 at 11:43 AM Ali Kathem <ali.kathem.edu@gmail.com> wrote:
// lib/kb.js

import fs from "fs";

import path from "path";



const DATA_DIR = path.join(process.cwd(), "data");



function safeReadJson(fileName) {

  try {

    const p = path.join(DATA_DIR, fileName);

    if (!fs.existsSync(p)) return [];

    const raw = fs.readFileSync(p, "utf8");

    const j = JSON.parse(raw);

    return Array.isArray(j) ? j : [];

  } catch {

    return [];

  }

}



// Load KB once at startup (cheap)

const KB = [

  ...safeReadJson("kb_common_issues.json"),

  ...safeReadJson("kb_maintenance.json"),

  ...safeReadJson("kb_fluids.json"),

];



// Each item format example:

// { "keywords": ["misfire","rough idle"], "snippet": "Rough idle + misfire often relates to..." }



function normalize(s) {

  return String(s || "").toLowerCase();

}



function scoreItem(query, item) {

  const q = normalize(query);

  const keys = Array.isArray(item.keywords) ? item.keywords : [];

  let score = 0;

  for (const k of keys) {

    const kk = normalize(k);

    if (!kk) continue;

    if (q.includes(kk)) score += 3;

    else {

      // partial

      const parts = kk.split(/\s+/).filter(Boolean);

      const hit = parts.some(p => p.length >= 4 && q.includes(p));

      if (hit) score += 1;

    }

  }

  return score;

}



export function kbFindSnippets(query, { limit = 6, maxCharsEach = 280 } = {}) {

  const q = normalize(query);

  if (!q || KB.length === 0) return [];



  const ranked = KB

    .map(item => ({ item, score: scoreItem(q, item) }))

    .filter(x => x.score > 0 && x.item && typeof x.item.snippet === "string")

    .sort((a, b) => b.score - a.score)

    .slice(0, limit)

    .map(x => {

      const s = x.item.snippet.trim();

      return s.length > maxCharsEach ? s.slice(0, maxCharsEach - 1) + "…" : s;

    });



  return ranked;

}
