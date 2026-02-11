// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
  if (!audioBase64 || audioBase64.length < 50) return "";
  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt: "Automotive diagnostic audio: knocking, squealing, ticking, rattling, misfire, bearing noise, belt noise.",
    });
    return result.text || "";
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return "";
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function inferLocale({ locale, text }) {
  if (locale && String(locale).trim()) return String(locale).trim();
  // quick Arabic detection
  if (text && /[\u0600-\u06FF]/.test(text)) return "ar";
  return "en";
}

export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    // IMPORTANT: accept both keys to avoid mismatch
    const text = body.text || "";
    const locale = inferLocale({ locale: body.locale, text });
    const user_location = body.user_location || "Global";

    // image key fix (accept both)
    const image_base_64 = body.image_base_64 || body.image_base64 || body.image_base_64;
    const audio_base_64 = body.audio_base_64 || body.audio_base64 || body.audio_base_64;
    const history = Array.isArray(body.history) ? body.history : [];

    // 1) transcribe audio (if any)
    const voiceText = await transcribeAudio(audio_base_64);
    const fullInput = `${text} ${voiceText}`.trim();

    // 2) Local verified search from /data
    const searchPack = await performSearch(fullInput, user_location);
    const VERIFIED_DATA = searchPack.verified_data || [];
    const VERIFIED_WORKSHOPS = searchPack.verified_workshops || [];

    // 3) Build user message content
    const messageContent = [];

    messageContent.push({
      type: "text",
      text:
`STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${user_location}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

USER_INPUT: ${fullInput}`
    });

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text: "Image task: identify the car part or fault evidence visible in the photo.",
      });
    }

    const response = await client.chat.completions.create({
      model: process.env.FIXLENS_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },

        // keep last turns for continuity, but not too many
        ...history.slice(-6),

        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    const out = response.choices?.[0]?.message?.content || "";
    return { ok: true, reply: out, locale };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);
    return { ok: false, reply: "System is under load. Please try again.", locale: "en" };
  }
}
