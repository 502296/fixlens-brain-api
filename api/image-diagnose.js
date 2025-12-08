// api/image-diagnose.js
// Receives: { imageBase64: string, userText?: string }

import { runFixLensBrain } from "./brain/index.js";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { imageBase64, userText } = req.body || {};

if (!imageBase64 || typeof imageBase64 !== "string") {
return res.status(400).json({
error: "Field 'imageBase64' (base64 image) is required.",
});
}

const result = await runFixLensBrain({
mode: "image",
text: userText || "",
imageBase64,
});

return res.status(200).json(result);
} catch (err) {
console.error("image-diagnose error:", err);
return res.status(500).json({
error: "Internal error in image-diagnose",
details: String(err),
});
}
}
