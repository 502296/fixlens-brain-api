import express from 'express';
import { handleFixLensMessage } from "./service.js";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
try {
const { text, sessionId, history } = req.body;

// استدعاء الوظيفة وانتظار الرد
const result = await handleFixLensMessage({
sessionId: sessionId || "anon",
userText: text,
history: history || []
});

// إرسال الرد مهما كانت النتيجة لمنع الـ 502
res.status(200).json(result);

} catch (e) {
console.error("Critical Server Error:", e);
res.status(200).json({ ok: false, text: "عذراً، واجه السيرفر مشكلة مؤقتة. حاول ثانية." });
}
});

app.listen(process.env.PORT || 3000);
