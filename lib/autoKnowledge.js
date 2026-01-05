import fs from "fs";
import path from "path";

const FALLBACK = [
  {
    keywords: ["derate", "freightliner", "cascadia", "tcm", "ecm", "voltage", "battery", "ground"],
    snippet:
      "Electrical instability (battery/ground/loose connections) can cause derate, delayed shifting, dash resets, and module communication faults. Prioritize battery cables, grounds, and main power distribution checks.",
  },
];

function loadKnowledge() {
  try {
    const p = path.join(process.cwd(), "data", "autoKnowledge.json");
    if (!fs.existsSync(p)) return FALLBACK;
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

const KB = loadKnowledge();

export function buildKnowledgeSnippets(text = "") {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return "";

  const hits = [];
  for (const item of KB) {
    const keys = Array.isArray(item.keywords) ? item.keywords : [];
    const ok = keys.some((k) => t.includes(String(k).toLowerCase()));
    if (ok && item.snippet) hits.push(String(item.snippet));
    if (hits.length >= 2) break;
  }

  if (!hits.length) return "";
  return hits.map((s, i) => `- KB${i + 1}: ${s}`).join("\n");
}
