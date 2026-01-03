// lib/dataHub.js

import fs from "fs";

import path from "path";



const DATA_DIR = path.join(process.cwd(), "data");

let CACHE = null;



function safeReadJson(p) {

  try {

    return JSON.parse(fs.readFileSync(p, "utf8"));

  } catch {

    return null;

  }

}



function toEntry(source, obj) {

  // normalize flexible schemas

  if (typeof obj === "string") {

    const t = obj.trim();

    return t ? { source, title: "", keywords: [], text: t } : null;

  }

  if (!obj || typeof obj !== "object") return null;



  const title =

    (typeof obj.title === "string" && obj.title.trim()) ||

    (typeof obj.name === "string" && obj.name.trim()) ||

    "";



  const keywords = Array.isArray(obj.keywords)

    ? obj.keywords.filter(x => typeof x === "string" && x.trim()).map(x => x.trim())

    : [];



  const text =

    (typeof obj.snippet === "string" && obj.snippet.trim()) ||

    (typeof obj.text === "string" && obj.text.trim()) ||

    (typeof obj.description === "string" && obj.description.trim()) ||

    (typeof obj.content === "string" && obj.content.trim()) ||

    "";



  if (!text) return null;

  return { source, title, keywords, text };

}



function flatten(source, json) {

  const out = [];

  if (Array.isArray(json)) {

    for (const it of json) {

      const e = toEntry(source, it);

      if (e) out.push(e);

    }

    return out;

  }

  if (json && typeof json === "object") {

    const single = toEntry(source, json);

    if (single) out.push(single);



    for (const [k, v] of Object.entries(json)) {

      if (Array.isArray(v)) {

        for (const it of v) {

          const e = toEntry(source, it);

          if (e) {

            if (!e.title) e.title = k;

            out.push(e);

          }

        }

      } else if (typeof v === "string") {

        const e = toEntry(source, { title: k, text: v });

        if (e) out.push(e);

      }

    }

  }

  return out;

}



export function loadKnowledgeBase() {

  if (CACHE) return CACHE;



  if (!fs.existsSync(DATA_DIR)) {

    CACHE = [];

    return CACHE;

  }



  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith(".json"));

  const all = [];



  for (const f of files) {

    const p = path.join(DATA_DIR, f);

    const json = safeReadJson(p);

    if (!json) continue;

    all.push(...flatten(f, json));

  }



  CACHE = all;

  return CACHE;

}



export function getKnowledgeBase() {

  return loadKnowledgeBase();

}
