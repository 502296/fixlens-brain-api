// api/diagnose.js (أو pages/api/diagnose.js في Next.js)

import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// 🔥 نظام التفكير العام لـ FixLens Auto Brain
const systemPrompt = `
You are **FixLens Auto Brain**, an AI assistant that helps drivers diagnose real-world car problems.

RULES:

1) When the user clearly describes a CAR PROBLEM (noises, vibrations, warning lights, smoke, steering, brakes, battery, transmission, electrical issues, body or paint damage, etc.):
- Answer in this **diagnostic template**:
1) **Summary**
2) **Possible Causes**
3) **What To Check First**
4) **Step-by-Step Fix**
5) **Safety Warnings**
- Be practical and focused on real cars and real-world situations.

2) When the message is just a **greeting or small talk**
(for example “hello”, “hi”, “hey”, “هلو”, “مرحبا”, “السلام عليكم”,
“hola”, “bonjour”, “ciao”, “hallo”, “selam”, “привет”, “안녕”, “こんにちは”, etc.):
- DO NOT use the diagnostic template.
- Answer like a friendly assistant:
- Greet the user back in a warm way.
- Briefly introduce yourself as “FixLens Auto Brain”.
- Politely ask them to describe their car problem or symptoms (noises, vibrations, warning lights, smells, leaks, etc.).
- Keep the answer short (2–4 sentences).

3) LANGUAGE:
- Always reply in **the same language** the user used in their message,
or in the language they explicitly ask for.
- If the user mixes languages, continue in the main language of the message.

4) GENERAL:
- If the question is not about cars at all, answer briefly and invite the user
to ask about a car issue.
- Never invent fake dangerous situations.
- If you are unsure, say that more details are needed.
`;

// 🧠 تحميل معرفة الأعطال من ملفات JSON (اختياري – لو موجودة)
function loadCarKnowledge() {
try {
const basePath = path.join(process.cwd(), "brain", "knowledge");

const carPath = path.join(basePath, "car.json");
const carExtraPath = path.join(basePath, "car_extra.json");

let items = [];

if (fs.existsSync(carPath)) {
const raw = fs.readFileSync(carPath, "utf8");
const json = JSON.parse(raw);
if (Array.isArray(json.items)) {
items = items.concat(json.items);
}
}

if (fs.existsSync(carExtraPath)) {
const raw = fs.readFileSync(carExtraPath, "utf8");
const json = JSON.parse(raw);
if (Array.isArray(json.items)) {
items = items.concat(json.items);
}
}

if (!items.length) return "";

const knowledge = items
.map((item) => {
const issue = item.issue || item.title || "";
const causes = item.causes || item.cause || "";
const fix = item.fix || item.solution || "";
return `Issue: ${issue}\nCauses: ${causes}\nFix: ${fix}`;
})
.join("\n\n");

return knowledge;
} catch (err) {
console.error("Error loading car knowledge:", err);
return "";
}
}

// 🎯 الـ API نفسه
export default async function handler(req, res) {
if (req.method !== "POST") {
return res.status(405).json({ error: "Method not allowed" });
}

try {
const {
issue, // النص الذي أرسله المستخدم
type, // "text" | "sound" | "vision"
languageCode, // مثل "en" أو "ar" أو "es" (اختياري)
hasImage,
hasAudio,
} = req.body || {};

if (!issue || typeof issue !== "string") {
return res.status(400).json({ error: "Field 'issue' (string) is required." });
}

const knowledge = loadCarKnowledge();

const contextLines = [
languageCode ? `User language code (if provided): ${languageCode}.` : "",
type ? `Input type: ${type}.` : "Input type: text.",
hasImage ? "User also attached an image of the car/problem." : "",
hasAudio ? "User also attached an audio recording of the car sound." : "",
].filter(Boolean);

const messages = [
{ role: "system", content: systemPrompt },
knowledge
? {
role: "system",
content:
"Here is domain knowledge about common car problems:\n\n" +
knowledge,
}
: null,
{
role: "user",
content:
(contextLines.length ? contextLines.join("\n") + "\n\n" : "") +
`User message:\n${issue}`,
},
].filter(Boolean);

const completion = await openai.chat.completions.create({
model: "gpt-4.1-mini",
messages,
temperature: 0.4,
max_tokens: 800,
});

const reply =
completion.choices?.[0]?.message?.content?.trim() ||
"Sorry, I couldn't generate a response.";

return res.status(200).json({ reply });
} catch (err) {
console.error("FixLens diagnose error:", err);
return res.status(500).json({
error: "FixLens Brain internal error.",
details: err.message || String(err),
});
}
}
