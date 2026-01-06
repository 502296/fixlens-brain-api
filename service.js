// ... (الاستيرادات المذكورة أعلاه)

export async function handleFixLensRequest(req) {
try {
const { text = "", image_base_64, audio_base_64, history = [], user_location = "Louisville, KY" } = req.body;

// تنفيذ البحث وتحويل الصوت بشكل متوازي لتوفير الوقت
const [voiceText, searchResults] = await Promise.all([
transcribeAudio(audio_base_64),
(text.includes("ورشة") || text.includes("عنوان")) ? performSearch(text, user_location) : Promise.resolve("")
]);

const fullQuery = `${text} ${voiceText || ""}`;

// ✅ استخدام ملفات /data
const localSpecs = fetchLocalData(fullQuery);
// ✅ استخدام autoKnowledge بأمان (إذا كانت الدالة موجودة)
const autoKnowledgeBase = getAutoKnowledge ? getAutoKnowledge(fullQuery) : "No extra knowledge available.";

const response = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: `${buildDoctorSystemPrompt()} Respond in the user's language. Use their language for headers.` },
...history.slice(-1),
{ role: "user", content: [
{ type: "text", text: `DATA: ${localSpecs}\nKB: ${autoKnowledgeBase}\nSEARCH: ${searchResults}\nQUERY: ${fullQuery}` },
...(image_base_64 ? [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "low" } }] : [])
]}
],
temperature: 0.1
});

return { ok: true, reply: response.choices[0].message.content };

} catch (error) {
console.error("Backend Error:", error);
return { ok: false, error: "System is restarting, please try again in seconds." };
}
}
