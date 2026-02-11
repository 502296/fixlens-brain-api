// search.js
import fs from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data");

// حمّل كل ملفات json مرة واحدة (كاش) لتسريع الأداء وتقليل الحمل
let CACHE = null;

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walkJsonFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) out.push(...walkJsonFiles(full));
    else if (it.isFile() && it.name.toLowerCase().endsWith(".json")) out.push(full);
  }
  return out;
}

function ensureCache() {
  if (CACHE) return CACHE;

  const files = walkJsonFiles(DATA_DIR);
  const docs = [];

  for (const f of files) {
    const json = safeReadJson(f);
    if (!json) continue;

    // نحول أي شكل JSON إلى نص قابل للبحث
    const text = JSON.stringify(json);

    docs.push({
      file: path.relative(process.cwd(), f),
      text,
      json,
    });
  }

  CACHE = { docs, builtAt: Date.now() };
  return CACHE;
}

function normalize(s) {
  return (s || "")
    .toString()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreDoc(queryTokens, docText) {
  let score = 0;
  for (const t of queryTokens) {
    if (!t || t.length < 3) continue;
    if (docText.includes(t)) score += 2;
  }
  return score;
}

function topSnippetsFromJson(json, maxChars = 1200) {
  // نحاول نطلع “مقاطع” مفهومة حتى لو JSON كبير
  // إذا الملف عندك أصلاً structured (sections, bullets...) راح يطلع مفيد جداً
  const pretty = JSON.stringify(json, null, 2);
  if (pretty.length <= maxChars) return pretty;
  return pretty.slice(0, maxChars) + "\n...TRUNCATED";
}

/**
 * بحث داخلي من ملفات data فقط
 * يعيد نص جاهز ينحط داخل البرومبت
 */
export async function performSearch(userInput, userLocation = "Global") {
  const { docs } = ensureCache();

  const q = normalize(userInput);
  if (!q || q.length < 3) return "";

  const tokens = q.split(" ").filter(Boolean).slice(0, 25);

  const ranked = docs
    .map((d) => ({
      file: d.file,
      score: scoreDoc(tokens, normalize(d.text)),
      json: d.json,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4); // أهم 4 ملفات

  if (ranked.length === 0) return "";

  const blocks = ranked.map((r, idx) => {
    return `SOURCE_${idx + 1}: ${r.file}\n${topSnippetsFromJson(r.json, 1200)}`;
  });

  return [
    `INTERNAL_KB_SEARCH (local data only)`,
    `USER_LOCATION: ${userLocation}`,
    ...blocks,
  ].join("\n\n");
}
