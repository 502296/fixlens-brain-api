// service.js
import OpenAI from "openai";
import { DOCTOR_PROMPT } from "./doctorPrompt.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function handleFixLensMessage({ sessionId, userText, history = [] }) {
try {
// التأكد من أن المفتاح والمطالبة موجودين
if (!process.env.OPENAI_API_KEY) throw new Error("Missing API Key");

const messages = [
{ role: "system", content: DOCTOR_PROMPT },
...history,
{ role: "user", content: userText }
];

const completion = await openai.chat.completions.create({
model: "gpt-4o", // موديل قوي يدعم الصور واللغة العربية بطلاقة
messages: messages,
temperature: 0.7,
});

const reply = completion.choices[0].message.content;

// إذا طلب الـ AI رمز بريدي للبحث عن أسعار
if (reply.includes("ZIP_REQUIRED")) {
return {
ok: true,
mode: "need_zip",
text: "لأتمكن من تزويدك بأسعار القطع والمحلات القريبة، فضلاً أرسل الرمز البريدي (ZIP Code) الخاص بمدينتك."
};
}

return { ok: true, text: reply, mode: "doctor" };

} catch (error) {
console.error("Critical Error in Service:", error.message);
// هذا السطر يمنع ظهور خطأ 502 ويرد برسالة ذكية
return { ok: false, text: "عذراً، دكتور ميكانيك يواجه ضغطاً حالياً. حاول مرة أخرى خلال لحظات." };
}
}
