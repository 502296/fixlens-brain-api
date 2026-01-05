import express from "express";
import cors from "cors";
import morgan from "morgan";
import { handleFixLensRequest } from "./service.js";

const app = express();

// Railway / production friendly
app.set("trust proxy", 1);

app.use(cors());
app.use(morgan("combined"));
app.use(express.json({ limit: "25mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "fixlens-brain-api",
    time: new Date().toISOString(),
  });
});

// Main endpoint
app.post("/api/fixlens", async (req, res) => {
  try {
    const out = await handleFixLensRequest(req);
    res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || "Unexpected error";

    console.error("API /api/fixlens error:", err);
    res.status(status).json({
      ok: false,
      error: message,
      status,
    });
  }
});

// Alias for Flutter (NO 404 anymore)
app.post("/api/chat", async (req, res) => {
  try {
    const out = await handleFixLensRequest(req);
    res.status(200).json(out);
  } catch (err) {
    const status = Number(err?.status || err?.statusCode || 500);
    const message = err?.message || "Unexpected error";

    console.error("API /api/chat error:", err);
    res.status(status).json({
      ok: false,
      error: message,
      status,
    });
  }
});

// Fallback
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND",
    path: req.path,
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`FixLens Brain API running on port ${PORT}`);
});

// Safety net
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED PROMISE:", err);
});
