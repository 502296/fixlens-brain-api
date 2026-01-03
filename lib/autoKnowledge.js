// lib/autoKnowledge.js

import { getKnowledgeBase } from "./dataHub.js";



function norm(s) {

  return String(s || "").toLowerCase();

}



function tokens(s) {

  return norm(s).replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(t => t.length >= 4);

}



function score(qTokens, e) {

  const t = norm(e.text);

  const title = norm(e.title);

  const keys = (e.keywords || []).map(norm);



  let s = 0;

  for (const tok of qTokens) {

    if (keys.some(k => k.includes(tok))) s += 4;

    if (title.includes(tok)) s += 2;

    if (t.includes(tok)) s += 1;

  }

  if (norm(e.source).includes("auto_common_issues")) s += 2;

  return s;

}



function clip(s, n) {

  const x = String(s || "").trim();

  if (x.length <= n) return x;

  return x.slice(0, n - 1) + "…";

}



export function buildKnowledgeSnippets(userText, { limit = 7, maxCharsEach = 260 } = {}) {

  const kb = getKnowledgeBase();

  if (!kb.length) return [];



  const q = tokens(userText);

  if (!q.length) return [];



  const ranked = kb

    .map(e => ({ e, s: score(q, e) }))

    .filter(x => x.s > 0)

    .sort((a, b) => b.s - a.s)

    .slice(0, limit)

    .map(x => {

      const head = x.e.title ? `${x.e.title}: ` : "";

      return head + clip(x.e.text, maxCharsEach);

    });



  // dedupe

  const seen = new Set();

  const out = [];

  for (const r of ranked) {

    const k = norm(r).slice(0, 120);

    if (seen.has(k)) continue;

    seen.add(k);

    out.push(r);

  }

  return out;

}
