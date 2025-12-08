// /api/image-diagnose.js
// FixLens – IMAGE DIAGNOSIS (multi-language)

import OpenAI from "openai";
import formidable from "formidable";
import fs from "fs";

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});

// لازم نعطل bodyParser لأننا نستقبل ملف
export const config = {
api: {
bodyParser: false,
},
};

export default async function handler(req, res) {
if (req.method !== "POST") {
return res
.status(405)
.json({ error: { code: 405, message: "Method not allowed" } });
}

try {
const form = formidable({ multiples: false });

const { fields, files } = await new Promise((resolve, reject) => {
form.parse(req, (err, fields, files) => {
if (err) reject(err);
else resolve({ fields, files });
});
});

const userText =
(fields?.description && String(fields.description)) ||
(fields?.message && String(fields.message)) ||
"Please diagnose what might be wrong in this car photo.";

// 👇 عدّل الاسم إذا كنت ترسل field آخر من Flutter (مثلاً photo)
const imageFile = files?.image || files?.file;
if (!imageFile) {
return res
.status(400)
.json({ error: { code: 400, message: "No image file uploaded." } });
}

const imageBytes = await fs.promises.readFile(imageFile.filepath);
const imageBase64 = imageBytes.toString("base64");

const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
temperature: 0.4,
messages: [
{
role: "system",
content: `
You are **FixLens Auto – Image Mode**, a smart assistant specialized in
understanding **photos of cars, engines, and mechanical parts**.

GOAL:
- Look carefully at the photo.
- Combine what you see with any text description from the user.
- Explain what the part is, what might be wrong, and what the driver should do.

LANGUAGE:
- Always answer in the **same language as the user's description**.
- If the user text is Arabic → reply Arabic.
- If English → reply English.
- If Spanish / Hindi / any other → reply in that language.
- Do NOT force English unless the user uses English only.

STYLE:
- Be clear, friendly, and not too technical.
- Use short sections:
1) Short summary.
2) What you see in the image.
3) Possible issues / what might be wrong.
4) What the user can check now.
5) Safety note and advice to visit a mechanic.

SAFETY:
- Never give unsafe instructions.
- Always remind the user that a real mechanic should inspect the car
for a final diagnosis.
`.trim(),
},
{
role: "user",
content: [
{
type: "text",
text: userText,
},
{
type: "image_url",
image_url: {
url: `data:image/jpeg;base64,${imageBase64}`,
},
},
],
},
],
});

const answer =
completion.choices?.[0]?.message?.content ||
"Sorry, I couldn't analyze this image.";

return res.status(200).json({ answer });
} catch (err) {
console.error("FixLens Image Diagnose error:", err);
return res.status(500).json({
error: { code: 500, message: "A server error has occurred (image)." },
});
}
}
