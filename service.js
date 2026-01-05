// ... (البداية كما هي: الاستيراد والإعدادات)

// تأكد من وجود كلمة export هنا ليراها ملف server.js
export async function handleFixLensRequest(req) {
// الكود الذي أرسلته سابقاً...
// تأكد من استدعاء الدوال الجديدة التي تستخدم Chat Completions
if (imageFile?.buffer?.length) {
const reply = await analyzeWithVision({ userText, locale, imageFile });
return { ok: true, reply, locale, meta: { usedVision: true } };
}

const reply = await analyzeWithText({ userText, locale });
return { ok: true, reply, locale, meta: { usedVision: false } };
}

// دالة النص (استخدم gpt-4o)
async function analyzeWithText({ userText, locale }) {
const system = buildDoctorSystemPrompt(locale);
const res = await client.chat.completions.create({
model: "gpt-4o", // هذا هو المودل الأفضل حالياً
messages: [
{ role: "system", content: system },
{ role: "user", content: userText }
]
});
return res.choices[0].message.content;
}

// دالة الصور (استخدم gpt-4o)
async function analyzeWithVision({ userText, locale, imageFile }) {
const system = buildDoctorSystemPrompt(locale);
const b64 = imageFile.buffer.toString("base64");
const res = await client.chat.completions.create({
model: "gpt-4o",
messages: [
{ role: "system", content: system },
{
role: "user",
content: [
{ type: "text", text: userText },
{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }
]
}
]
});
return res.choices[0].message.content;
}
