// api/diagnose.js

export const config = {
runtime: "nodejs",
};

import OpenAI from "openai";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// Safe getter
function safe(v) {
if (!v) return "";
if (typeof v !== "string") return "";
return v.trim();
}

function buildPrompt() {
return `
You are FixLens Auto. Detect the user's language and always reply in that language.

Your structure:
1) Quick summary
2) Most likely causes
3) What the user can check now
4) Safety advice
5) Professional next step

If the user only sends "hello" or a greeting, reply friendly in the same language and ask them to describe the car issue.
`;
}

export default async function handler(req, res) {
try {
if (req.method !== "POST") {
return res.status(405).json({ code: 405, message: "POST only." });
}

const body = req.body || {};
const mode = safe(body.mode || "text");
const message = safe(body.message);

if (mode === "text") {
if (!message) {
return res
.status(400)
.json({ code: 400, message: "Message required." });
}

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages: [
{ role: "system", content: buildPrompt() },
{ role: "user", content: message },
],
});

return res.status(200).json({
code: 200,
diagnosis: completion.choices[0].message.content.trim(),
});
}

return res.status(400).json({
code: 400,
message: `Unsupported mode "${mode}". Only "text" is enabled now.`,
});
} catch (err) {
console.error("FixLens diagnose error →", err);
return res.status(500).json({
code: 500,
message: "Internal server error",
error: String(err),
});
}
}
