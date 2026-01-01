import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const SESSIONS = new Map();

// العقل المدبر مدمج هنا لضمان عدم حدوث خطأ في الاستدعاء
const DOCTOR_PROMPT = `You are FixLens, a Master Mechanic.
- Respond in the user's language (Arabic/English).
- NO bullet points, NO headings. One professional paragraph.
- If the user asks for prices/stores and you don't have a ZIP, reply ONLY with: ZIP_REQUIRED
- Be professional like a high-end US workshop.`;

export async function handleFixLensMessage({ sessionId, userText, history = [] }) {
try {
const s = SESSIONS.get(sessionId) || { zip: null };

// منطق الـ ZIP السريع
if (/^\d{5}$/.test(userText.trim())) {
s.zip = userText.trim();
SESSIONS.set(sessionId, s);
return { ok: true, text: "تم حفظ الرمز البريدي. كيف يمكنني مساعدتك في البحث عن القطع؟" };
}

const messages = [
{ role: "system", content: DOCTOR_PROMPT },
...history,
{ role: "user", content: userText }
];

const completion = await openai.chat.completions.create({
model: "gpt-4o", // تأكد من شحن حسابك في OpenAI لاستخدام هذا الموديل
messages: messages,
});

return { ok: true, text: completion.choices[0].message.content };
} catch (error) {
console.error("AI Error:", error.message);
return { ok: false, error: "AI_ERROR", detail: error.message };
}
}
