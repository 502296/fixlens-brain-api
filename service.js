// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
  if (!audioBase64 || String(audioBase64).length < 50) return { text: "", ok: false };

  // NOTE: you currently assume m4a. If Flutter sends a different format later, we can add audio_mime handling.
  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);

  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt:
        "Automotive diagnostic audio. Focus on noises: knock, ping, squeal, grind, tick, rattle, hiss, bearing, belt, misfire.",
    });

    const text = (result?.text || "").trim();
    return { text, ok: Boolean(text) };
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return { text: "", ok: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function detectLocaleFromHistory(history) {
  if (!Array.isArray(history)) return "";
  // look at last user message string content if any
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role !== "user") continue;

    const c = msg?.content;
    if (typeof c === "string" && /[\u0600-\u06FF]/.test(c)) return "ar";
    // sometimes content can be array (multimodal)
    if (Array.isArray(c)) {
      const joined = c
        .map((x) => (typeof x?.text === "string" ? x.text : ""))
        .join(" ");
      if (/[\u0600-\u06FF]/.test(joined)) return "ar";
    }
  }
  return "";
}

function inferLocale({ locale, text, history }) {
  if (locale && String(locale).trim()) return String(locale).trim();

  const fromHistory = detectLocaleFromHistory(history);
  if (fromHistory) return fromHistory;

  if (text && /[\u0600-\u06FF]/.test(text)) return "ar";
  return "en";
}

export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text = body.text || "";
    const history = Array.isArray(body.history) ? body.history : [];

    const locale = inferLocale({ locale: body.locale, text, history });
    const user_location = body.user_location || "Global";

    const image_base_64 = body.image_base_64 || body.image_base64 || "";
    const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

    // 1) transcribe audio (if any)
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;
    const fullInput = `${text} ${voiceText}`.trim();

    // 2) Local verified search from /data + optional Google Places
    const searchPack = await performSearch(fullInput || text, user_location);
    const VERIFIED_DATA = searchPack.verified_data || [];
    const VERIFIED_WORKSHOPS = searchPack.verified_workshops || [];

    // 3) Build user message content
    const messageContent = [];

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${user_location}

AUDIO_TRANSCRIPT_OK: ${audioResult.ok ? "YES" : (audio_base_64 ? "NO" : "NO_AUDIO")}
AUDIO_TRANSCRIPT: ${voiceText || ""}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

USER_INPUT: ${(text || "").trim()}`,
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text:
          "Use the photo to identify visible parts, damage, leaks, wear, or incorrect installation. Tie findings to diagnosis.",
      });
    }

    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        ...history.slice(-8),
        { role: "user", content: messageContent },
      ],
      temperature: 0.2,
    });

    const out = response.choices?.[0]?.message?.content || "";
    return { ok: true, reply: out, locale, workshops_count: VERIFIED_WORKSHOPS.length };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);
    return { ok: false, reply: "System is under load. Please try again.", locale: "en" };
  }
}
