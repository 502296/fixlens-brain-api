// server.js
import express from 'express';
import { handleFixLensMessage } from "./lib/service.js"; // Ensure path is correct

const app = express();
// Increased limit for Base64 images
app.use(express.json({ limit: '10mb' }));

app.post("/api/chat", async (req, res) => {
try {
const { text, image, sessionId, history } = req.body;

const result = await handleFixLensMessage({
sessionId: sessionId || "session_123",
userText: text,
imageBase64: image, // iOS should send this as a Base64 string
history: history || []
});

res.status(200).json(result);

} catch (e) {
console.error("Server Route Error:", e);
res.status(500).json({ ok: false, error: "CRITICAL_SERVER_ERROR" });
}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FixLens Engine active on port ${PORT}`));
