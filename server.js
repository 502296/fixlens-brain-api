// server.js
import express from 'express';
import { handleFixLensMessage } from "./lib/service.js";

const app = express();
app.use(express.json({ limit: '20mb' })); // Increased limit for images

// IMPORTANT: This route must match what your App is calling
// If your app calls /api/chat, use /api/chat.
// Based on your error "Cannot POST /api/dia", I will add that specific route:
app.post("/api/chat", async (req, res) => {
await processRequest(req, res);
});

// Adding the route that caused the 404 error just in case
app.post("/api/diagnose", async (req, res) => {
await processRequest(req, res);
});

async function processRequest(req, res) {
try {
const { text, image, sessionId, history } = req.body;
const result = await handleFixLensMessage({
sessionId: sessionId || "anon",
userText: text,
imageBase64: image,
history: history || []
});
res.status(200).json(result);
} catch (e) {
res.status(200).json({ ok: false, text: "Server Connection Error" });
}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Doctor Mechanic running on port ${PORT}`));
