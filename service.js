import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

// ✅ استيراد آمن لمنع SyntaxError الظاهر في صورك
import * as autoKB from "./lib/autoKnowledge.js";
const getAutoKnowledge = autoKB.getAutoKnowledge || null;

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ دالة تحويل الصوت (يجب أن تكون قبل الاستدعاء لمنع ReferenceError)
async function transcribeAudio(audioBase64) {
if (!audioBase64 || audioBase64.length < 50) return "";
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Car engine diagnostic: rod knock, fan belt squeal, misfire."
});
return result.text;
} catch (err) { return ""; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64, audio_base_64, user_location = "Global", history = [] } = req.body;

const voiceText = await transcribeAudio(audio_base_64);
const combinedInput = `${text} ${voiceText}`.trim();

// تفعيل البحث العالمي (لن يمسح)
let searchResults = "";
if (combinedInput.includes("ورشة") || combinedInput.includes("shop")) {
searchResults = await performSearch(combinedInput, user_location);
}

const messageContent = [
{ type: "text", text: `[GLOBAL BRAIN CONTEXT]\nLOCATION: ${user_location}\nSEARCH: ${searchResults}\nINPUT: ${combinedInput}` }
];

if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" }
});
messageContent.push({ type: "text", text: "TASK: Identify this car part and diagnose failure." });
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{ role: "user", content: messageContent }
],
temperature: 0.1 // دقة جراحية عالمية
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) {
console.error("Critical Error:", error.message);
return { ok: false, error: "System Error." };
}
}
