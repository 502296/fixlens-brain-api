// server.js
import express from "express";
import cors from "cors";
import { handleFixLensRequest } from "./service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// ---------- Helpers ----------
function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function normalizeLocale(locale = "en") {
  const l = String(locale || "en").trim();
  if (!l) return "en";
  return l.split("-")[0].toLowerCase();
}

function isArabicText(s) {
  const t = safeStr(s);
  return /[\u0600-\u06FF]/.test(t);
}

function shouldArabic(locale, userText) {
  const l = normalizeLocale(locale);
  return l === "ar" || isArabicText(userText);
}

function stripDataUrl(b64) {
  const s = safeStr(b64).trim();
  const idx = s.indexOf("base64,");
  return idx >= 0 ? s.slice(idx + "base64,".length) : s;
}

function b64ToBuffer(b64) {
  const cleaned = stripDataUrl(b64);
  if (!cleaned) return null;
  try {
    return Buffer.from(cleaned, "base64");
  } catch {
    return null;
  }
}

function nowISO() {
  return new Date().toISOString();
}

// ---------- Routes ----------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "fixlens-brain-api",
    hint: "Use /health or POST /api/chat",
    time: nowISO(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "fixlens-brain-api", time: nowISO() });
});

app.post("/api/chat", (req, res) => processRequest(req, res));
app.post("/api/diagnose", (req, res) => processRequest(req, res));
app.post("/api/dial", (req, res) => processRequest(req, res));
app.post("/v1/doctor", (req, res) => processRequest(req, res));

// ---------- Main handler ----------
async function processRequest(req, res) {
  try {
    const body = req.body || {};
    const {
      text,
      image,        // base64 string OR { base64, mime }
      audio,        // { base64, mime } OR null
      locale = "en",
      history = [], // expected array: [{role:'user'|'assistant', content:'...'}]
      sessionId = "",
      audioTranscript = "",
    } = body;

    // 1) Build image object FIRST
    const imageObj =
      typeof image === "string"
        ? { base64: image, mime: "image/jpeg" }
        : image && typeof image.base64 === "string"
        ? { base64: image.base64, mime: image.mime || "image/jpeg" }
        : null;

    // 2) Build audio object FIRST
    const audioObj =
      audio && typeof audio.base64 === "string"
        ? { base64: audio.base64, mime: audio.mime || "audio/m4a" }
        : null;

    // 3) Build safe text (if empty but media exists) — IN USER LANGUAGE
    const hasText = typeof text === "string" && text.trim().length > 0;
    const userText = hasText ? text.trim() : "";
    const useArabic = shouldArabic(locale, userText);

    let safeText = userText;

    if (!safeText && audioObj) {
      safeText = useArabic
        ? "حلّل تسجيل صوت السيارة المرفق. أعطني بحد أقصى 3 أسباب محتملة، وقل هل القيادة آمنة الآن، واسأل سؤالاً واحداً فقط إذا احتجت."
        : "Analyze the attached car audio recording. Return max 3 likely causes, say whether it's safe to keep driving, and ask at most ONE follow-up question if needed.";
    }

    if (!safeText && imageObj) {
      safeText = useArabic
        ? "حلّل صورة السيارة المرفقة. أعطني بحد أقصى 3 أسباب محتملة، وقل هل القيادة آمنة الآن، واسأل سؤالاً واحداً فقط إذا احتجت."
        : "Analyze the attached car photo. Return max 3 likely causes, say whether it's safe to keep driving, and ask at most ONE follow-up question if needed.";
    }

    if (!safeText) {
      safeText = useArabic
        ? "صف المشكلة باختصار: الأعراض، أي لمبة تحذير، ومتى تظهر المشكلة (عند التسارع، الفرملة، أو الوقوف)."
        : "Describe the car problem briefly: symptoms, any warning lights, and when it happens (acceleration, braking, or idling).";
    }

    // 4) Convert base64 to buffers
    const imageBuffer = imageObj ? b64ToBuffer(imageObj.base64) : null;
    const audioBuffer = audioObj ? b64ToBuffer(audioObj.base64) : null;

    // 5) Call FixLens Pro brain (search stays inside service.js)
    const result = await handleFixLensRequest({
      text: safeText,
      locale: normalizeLocale(locale),
      history: Array.isArray(history) ? history : [],
      sessionId: safeStr(sessionId),

      hasImage: Boolean(imageBuffer),
      imageBuffer,
      imageMime: imageObj?.mime || "image/jpeg",

      hasAudio: Boolean(audioBuffer),
      audioBuffer,
      audioMime: audioObj?.mime || "audio/m4a",

      audioTranscript: safeStr(audioTranscript),
    });

    if (!result?.ok) {
      return res.status(500).json({
        ok: false,
        error: result?.error || "SERVER_ERROR",
        reply: "",
      });
    }

    return res.json({
      ok: true,
      reply: safeStr(result.reply),
      meta: result.meta || {},
    });
  } catch (err) {
    console.error("processRequest error:", err?.message || err);
    return res.status(500).json({
      ok: false,
      error: "PROCESS_REQUEST_FAILED",
      reply: "",
    });
  }
}

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});
