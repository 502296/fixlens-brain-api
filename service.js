// استبدل دالة analyzeWithText بهذه النسخة المستقرة
async function analyzeWithText({ userText, locale }) {
const system = buildDoctorSystemPrompt(locale);
const model = process.env.FIXLENS_MODEL || "gpt-4o";

try {
const response = await client.chat.completions.create({
model: model,
messages: [
{ role: "system", content: system },
{ role: "user", content: userText },
],
temperature: 0.7,
});

const out = response.choices[0]?.message?.content || "";
if (!out.trim()) throw new Error("Empty response from OpenAI");
return out;
} catch (err) {
console.error("OpenAI Text Error:", err);
throw err;
}
}

// استبدل دالة analyzeWithVision بهذه النسخة
async function analyzeWithVision({ userText, locale, imageFile }) {
const system = buildDoctorSystemPrompt(locale);
const model = "gpt-4o"; // مودل 4o هو الأفضل للصور
const b64 = imageFile.buffer.toString("base64");
const mime = imageFile.mimetype || "image/jpeg";

try {
const response = await client.chat.completions.create({
model: model,
messages: [
{ role: "system", content: system },
{
role: "user",
content: [
{ type: "text", text: userText },
{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
],
},
],
});

return response.choices[0]?.message?.content || "";
} catch (err) {
console.error("OpenAI Vision Error:", err);
throw err;
}
}
