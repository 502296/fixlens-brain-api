// server.js (inside your endpoint)
import { handleFixLensMessage } from "./service.js";

app.post("/api/chat", async (req, res) => {
  try {
    const sessionId =
      req.headers["x-session-id"] ||
      req.body.sessionId ||
      "anon";

    const userText = req.body.text || "";

    const out = await handleFixLensMessage({
      sessionId,
      userText,
      history: req.body.history || [],
    });

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: "SERVER_ERROR", detail: String(e?.message || e) });
  }
});
