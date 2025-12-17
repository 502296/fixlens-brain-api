import fs from "fs";
import path from "path";

let cache = null;

export function loadDataHub() {
  if (cache) return cache;

  const dataDir = path.join(process.cwd(), "data");
  const files = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter(f => f.endsWith(".json"))
    : [];

  const byFile = {};
  for (const f of files) {
    const full = path.join(dataDir, f);
    const raw = fs.readFileSync(full, "utf8");
    try {
      byFile[f] = JSON.parse(raw);
    } catch (e) {
      byFile[f] = [];
      console.error("JSON parse error:", f, e.message);
    }
  }

  cache = {
    dataDir,
    files,
    byFile,
    totalItems: Object.values(byFile).reduce(
      (n, arr) => n + (Array.isArray(arr) ? arr.length : 0),
      0
    ),
  };

  return cache;
}
