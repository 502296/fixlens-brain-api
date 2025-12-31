import fs from "fs";
import path from "path";

export async function loadAutoKnowledge() {
  const dataDir = path.join(process.cwd(), "data");
  const files = fs.readdirSync(dataDir);

  let knowledge = "";

  for (const file of files) {
    if (file.endsWith(".json")) {
      const content = fs.readFileSync(
        path.join(dataDir, file),
        "utf-8"
      );
      knowledge += content + "\n";
    }
  }

  return knowledge;
}
