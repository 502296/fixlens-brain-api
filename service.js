import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
});
return result.text;
} catch (err) { return null; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
// توحيد المسميات لإنهاء أخطاء السجلات (ReferenceError)
let {
text = "",
image_base64,
audio_base64, // تأكد أن هذا يطابق ما يرسله تطبيقك
history = [],
user_location = "Global"
} = req.body;

// معالجة الصوت
if (audio_base_64) {
const voiceText = await transcribeAudio(audio_base_64);
if (voiceText) text = `[AUDIO]: "${voiceText}". ${text}`.trim();
}

// تفعيل البحث
let searchResults = "";
if (["shop", "parts", "junk", "tire", "battery", "where", "ورشة"].some(k => text.toLowerCase().includes(k))) {
searchResults = await performSearch(text, user_location);
}

const finalPayload = `
REGION: ${user_location}
INPUT: ${text}
LOCAL_DATA: ${searchResults || "Search enabled"}
`.trim();

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-2),
{ role: "user", content: image_base64 ? [
{ type: "text", text: finalPayload },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base_64}` } }
] : finalPayload }
],
temperature: 0.3
});

return { ok: true, reply: response.choices[0].message.content };
} catch (error) { throw error; }
}
