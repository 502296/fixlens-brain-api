// server.js
import express from "express";
import cors from "cors";
import multer from "multer";
import os from "os";
import fs from "fs";

import {
diagnoseText,
diagnoseImage,
diagnoseAudio,
getDataHealth,
} from "./lib/service.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
res.setTimeout(240000);
next();
});

const upload = multer({
storage: multer.diskStorage({
destination: (req, file, cb) => cb(null, os.tmpdir()),
filename: (req, file, cb) => {
const safeName = (file.originalname || "upload").replace(/[^\w.\-]+/g, "_");
cb(null, `fixlens_${Date.now()}_${safeName}`);
},
}),
limits: { fileSize: 50 * 1024 * 1024 },
});

// --------------------
// Language helpers
// --------------------
function normalizeLang(code) {
if (!code) return null;
const c = String(code).trim();
if (!c) return null;

// take first token only if user accidentally sent "ar-IQ,ar;q=0.9"
const first = c.split(",")[0].trim();
if (!first) return null;

const lower = first.toLowerCase();
if (lower === "auto") return "auto";

// BCP-47-ish simple validation: "en" / "ar-IQ" / "pt-BR"
if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(first)) return null;
return first;
}

// ✅ helper: get preferred language from body/fields/header
function resolvePreferredLanguage(req, bodyPreferred) {
// 1) body / form field (Flutter sends this)
const bodyLang = normalizeLang(bodyPreferred);
if (bodyLang) return bodyLang;

// 2) custom header (optional future)
const xLang = normalizeLang(req.headers["x-fixlens-lang"]);
if (xLang) return xLang;

// 3) accept-language
const hdr = (req.headers["accept-language"] || "").toString().trim();
if (hdr) {
const first = hdr.split(",")[0].trim();
const h = normalizeLang(first);
if (h) return h;
}

// 4) last fallback
return "en";
}

function setContentLanguage(res, lang) {
const L = normalizeLang(lang) || "en";
res.setHeader("Content-Language", L);
}

app.get("/", (req, res) => res.status(200).send("FixLens Brain API is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.get("/health/data", (req, res) => {
try {
const out = getDataHealth();
res.status(200).json(out);
} catch (err) {
console.error("DATA HEALTH ERROR:", err);
res.status(500).json({
ok: false,
error: "Data health failed",
details: err?.message || String(err),
});
}
});

// ---------- TEXT ----------
app.post("/api/diagnose", async (req, res) => {
try {
const { message, preferredLanguage, vehicleInfo, mode } = req.body || {};
const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

const out = await diagnoseText({
message,
preferredLanguage: resolvedLang,
vehicleInfo,
mode: mode || "doctor",
});

setContentLanguage(res, out?.language || resolvedLang);
res.status(200).json(out);
} catch (err) {
console.error("TEXT ERROR:", err);
res.status(500).json({
error: "Text diagnosis failed",
details: err?.message || String(err),
});
}
});

// ---------- IMAGE ----------
app.post("/api/image-diagnose", upload.single("image"), async (req, res) => {
const file = req.file;

try {
const { message, preferredLanguage, vehicleInfo, mode } = req.body || {};
if (!file?.path) {
return res.status(400).json({ error: "Image diagnosis failed", details: "No image" });
}

const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

const imageBuffer = fs.readFileSync(file.path);

const out = await diagnoseImage({
message,
preferredLanguage: resolvedLang,
vehicleInfo,
imageBuffer,
imageMime: file.mimetype,
mode: mode || "doctor",
});

setContentLanguage(res, out?.language || resolvedLang);
res.status(200).json(out);
} catch (err) {
console.error("IMAGE ERROR:", err);
res.status(500).json({
error: "Image diagnosis failed",
details: err?.message || String(err),
});
} finally {
try { if (file?.path) fs.unlinkSync(file.path); } catch {}
}
});

// ---------- AUDIO ----------
app.post("/api/audio-diagnose", upload.single("audio"), async (req, res) => {
const file = req.file;

try {
const { message, preferredLanguage, vehicleInfo, mode } = req.body || {};
if (!file?.path) {
return res.status(400).json({ error: "Audio diagnosis failed", details: "No audio file received" });
}

const resolvedLang = resolvePreferredLanguage(req, preferredLanguage);

const audioBuffer = fs.readFileSync(file.path);
if (!audioBuffer || audioBuffer.length < 200) {
return res.status(400).json({ error: "Audio diagnosis failed", details: "Audio file is too small or empty" });
}

const out = await diagnoseAudio({
message,
preferredLanguage: resolvedLang,
vehicleInfo,
audioBuffer,
audioMime: file.mimetype,
audioOriginalName: file.originalname,
mode: mode || "doctor",
});

setContentLanguage(res, out?.language || resolvedLang);
res.status(200).json(out);
} catch (err) {
console.error("AUDIO ERROR:", err);
res.status(500).json({
error: "Audio diagnosis failed",
details: err?.message || String(err),
});
} finally {
try { if (file?.path) fs.unlinkSync(file.path); } catch {}
}
});

// ---------- Railway listen ----------
const PORT = Number(process.env.PORT || 8080);
const server = app.listen(PORT, "0.0.0.0", () =>
console.log("FixLens Brain running on port", PORT)
);

server.setTimeout(240000);
