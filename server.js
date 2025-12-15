// server.js
import express from "express";
import cors from "cors";

import diagnose from "./api/diagnose.js";
import imageDiagnose from "./api/image-diagnose.js";
import audioDiagnose from "./api/audio-diagnose.js";

const app = express();

// ✅ CORS (safe default)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ✅ Body limits (Base64 audio/images can be big)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ✅ Health checks (important for Railway)
app.get("/", (req, res) => res.status(200).send("FixLens Brain API is running ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// ✅ Routes
app.post("/api/diagnose", diagnose);
app.post("/api/image-diagnose", imageDiagnose);
app.post("/api/audio-diagnose", audioDiagnose);

// ✅ Global error handler (so crashes become logs)
app.use((err, req, res, next) => {
  console.error("GLOBAL ERROR:", err);
  res.status(500).json({
    error: "Server error",
    details: err?.message || String(err),
  });
});

// ✅ Log unexpected crashes instead of silent stop
process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

// ✅ Railway port
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, "0.0.0.0", () => {
  console.log("FixLens Brain running on port", PORT);
});
