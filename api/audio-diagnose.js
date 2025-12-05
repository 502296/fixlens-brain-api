// api/audio-diagnose.js
// Temporary handler for audio diagnosis

export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Only POST allowed" });
}

let body = req.body;
if (!body || typeof body === "string") {
try {
body = JSON.parse(body || "{}");
} catch (e) {
return res.status(400).json({ error: "Invalid JSON body" });
}
}

const { audio } = body || {};

if (!audio) {
return res
.status(400)
.json({ error: "Field 'audio' (base64) is required." });
}

// حالياً نرجّع رسالة ثابتة، فقط للتأكد من أن الربط يعمل
return res.status(200).json({
reply:
"FixLens received your audio note. Audio-based diagnostics will be enabled in the next version.",
});
}
