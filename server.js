import express from 'express';
import { handleFixLensMessage } from "./service.js";

const app = express();
app.use(express.json());

app.post("/api/chat", async (req, res) => {
try {
const { text, sessionId, history } = req.body;

if (!text) return res.status(400).json({ ok: false, error: "Text is required" });

// نرسل الطلب للـ Service وننتظر النتيجة
const result = await handleFixLensMessage({
sessionId: sessionId || "anon",
userText: text,
history: history || []
});

res.json(result);

} catch (error) {
console.error("Server Crash:", error);
// إرسال JSON بدلاً من انهيار السيرفر يمنع ظهور خطأ 502 للمستخدم
res.status(500).json({ ok: false, error: "Internal Server Error" });
}
});

app.listen(3000, () => console.log("FixLens Engine Running on port 3000"));
