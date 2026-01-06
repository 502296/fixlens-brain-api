import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Whisper مبرمج لفهم المصطلحات الميكانيكية بكل اللغات
async function transcribeAudio(audioBase64) {
if (!audioBase64) return "";
const tempPath = path.join("/tmp", `voice_${Date.now()}.m4a`);
try {
fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
const result = await client.audio.transcriptions.create({
file: fs.createReadStream(tempPath),
model: "whisper-1",
prompt: "Automotive engine sounds: knocking, squealing, grinding, misfire, diagnostic."
});
return result.text;
} catch (err) { return ""; }
finally { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
}

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64, audio_base_64, user_location = "Global", history = [] } = req.body;

// معالجة الصوت والبحث العالمي في نفس الوقت
const [voiceText, searchResults] = await Promise.all([
transcribeAudio(audio_base_64),
(text.length > 2 || audio_base_64) ? performSearch(`${text} ${voiceText}`, user_location) : Promise.resolve("")
]);

const combinedInput = `${text} ${voiceText}`.trim();

const messageContent = [
{
type: "text",
text: `[GLOBAL CONTEXT]: Mechanical inspection in ${user_location}.\n[SEARCH_DATA]: ${searchResults}\n[USER_INPUT]: ${combinedInput}`
}
];

if (image_base_64) {
messageContent.push({
type: "image_url",
image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" }
});
messageContent.push({
type: "text",
text: "Analyze this car part for mechanical failure and wear."
});
}

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: buildDoctorSystemPrompt() },
...history.slice(-3),
{ role: "user", content: messageContent }
],
temperature: 0.1
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
return { ok: false, error: "Global System Error." };
}
}
