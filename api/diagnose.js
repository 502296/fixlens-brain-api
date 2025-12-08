// api/diagnose.js
import { runFixLensBrain } from "../lib/fixlensBrain.js";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { message } = req.body || {};

if (!message || typeof message !== "string") {
return res.status(400).json({ error: "Field 'message' is required." });
}

const result = await runFixLensBrain({
mode: "text",
text: message,
});

return res.status(200).json(result);
} catch (err) {
console.error("diagnose error:", err);
return res
.status(500)
.json({ error: "Internal error in diagnose", details: String(err) });
}
}
