import OpenAI from "openai";
import { loadIssues } from "../lib/autoKnowledge.js";

export const config = {
runtime: "edge",
};

const client = new OpenAI({
apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(req) {
try {
const body = await req.json();
const base64 = body.imageBase64 || "";
if (!base64) {
return new Response(JSON.stringify({ error: "Missing image" }), { status: 400 });
}

const issues = loadIssues();

const systemPrompt = `
You are FixLens Auto — an AI expert in vehicle visual diagnostics.
You ALWAYS speak in the user's detected language.
Describe what you see in the image and then give:
1) Possible problems.
2) Severity.
3) Safety warnings.
4) Steps to verify the problem.

Be confident and helpful.
`;

const completion = await client.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: systemPrompt },
{
role: "user",
content: [
{
type: "image_url",
image_url: `data:image/jpeg;base64,${base64}`
},
{ type: "text", text: "Analyze this car photo." }
]
}
]
});

const reply = completion.choices[0].message.content;

return new Response(JSON.stringify({
reply
}), { status: 200 });

} catch (err) {
return new Response(JSON.stringify({
error: "SERVER_ERROR",
details: err.message
}), { status: 500 });
}
}
