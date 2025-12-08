import { runFixLensBrain } from "./brain/index.js";

export default async function handler(req, res) {
if (req.method !== "POST") {
res.setHeader("Allow", "POST");
return res.status(405).json({ error: "Method not allowed" });
}

try {
const { imageBase64, userText } = req.body || {};

if (!imageBase64) {
return res.status(400).json({
error: "imageBase64 is required",
});
}

const modelInput = [
{
role: "user",
content: [
{
type: "input_text",
text: userText || "",
},
{
type: "input_image",
image_base64: imageBase64,
},
],
},
];

const result = await runFixLensBrain({
mode: "image",
input: modelInput,
});

return res.status(200).json(result);
} catch (err) {
console.error("IMAGE ERROR:", err);
return res.status(500).json({
error: "Internal image error",
details: String(err),
});
}
}
