// server.js

import express from "express";

import cors from "cors";

import { doctorReply } from "./lib/service.js";



const app = express();



app.use(cors());

app.use(express.json({ limit: "25mb" })); // good for images later



// Health check

app.get("/health", (req, res) => {

  res.json({ ok: true, service: "fixlens-brain-api", time: new Date().toISOString() });

});



// Keep your existing endpoints so Flutter doesn't need changes

app.post("/api/chat", async (req, res) => processRequest(req, res));

app.post("/api/diagnose", async (req, res) => processRequest(req, res));

app.post("/api/dia", async (req, res) => processRequest(req, res));



// (Optional) new clean endpoint if you want later

app.post("/v1/doctor", async (req, res) => processRequest(req, res));



async function processRequest(req, res) {

  try {

    const { text, image, sessionId, history, locale, audio } = req.body || {};



    if (!text || typeof text !== "string" || text.trim().length === 0) {

      // keep 200 to avoid breaking Flutter flows, but mark ok:false clearly

      return res.status(200).json({ ok: false, text: "Missing text input." });

    }



    const result = await doctorReply({

      text: text.trim(),

      locale: locale || "en",

      history: Array.isArray(history) ? history : [],

      image: image ? { base64: image, mime: "image/jpeg" } : null,

      audio: audio || null,

    });



    if (!result.ok) {

      // keep 200 for Flutter, but include debug info (safe)

      return res.status(200).json({

        ok: false,

        text: result.reply || "AI service is not reachable right now.",

        error: result.error || "UNKNOWN",

        meta: result.meta || {},

      });

    }



    return res.status(200).json({

      ok: true,

      text: result.reply,

      meta: result.meta || {},

    });

  } catch (e) {

    console.error("Critical Server Error:", e);

    return res.status(200).json({

      ok: false,

      text: "Internal Server Error. Please try again.",

      error: "SERVER_ERROR",

      message: e?.message || "Unknown",

    });

  }

}



const PORT = process.env.PORT || 3000;

app.listen(PORT, () => console.log(`FixLens Brain running on port ${PORT}`));
