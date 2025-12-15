// api/_utils.js
export async function readJsonBody(req) {
  // Vercel أحياناً ما يجهّز req.body لبعض runtimes/handlers
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  if (!chunks.length) return null;

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function safeBase64ToBuffer(base64) {
  if (!base64 || typeof base64 !== "string") return null;
  // لو جاك dataURL امسح الهيدر
  const clean = base64.includes(",") ? base64.split(",").pop() : base64;
  try {
    return Buffer.from(clean, "base64");
  } catch {
    return null;
  }
}

export function extFromMime(mimeType = "") {
  const m = mimeType.toLowerCase();
  if (m.includes("m4a")) return "m4a";
  if (m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  return "m4a";
}
