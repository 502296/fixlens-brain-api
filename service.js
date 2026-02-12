// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";
import { searchPlacesWorkshops } from "./places.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeAudio(audioBase64) {
  if (!audioBase64 || audioBase64.length < 50) return "";
  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      prompt:
        "Automotive diagnostic audio: knocking, squealing, ticking, rattling, misfire, bearing noise, belt noise.",
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
  if (text && /[\u0600-\u06FF]/.test(text)) return "ar";
  return "en";
}

function wantsWorkshops(text) {
  const t = (text || "").toLowerCase();
  // Arabic + English triggers
  return (
    t.includes("ورشة") ||
    t.includes("ميكانيك") ||
    t.includes("كراج") ||
    t.includes("تصليح") ||
    t.includes("garage") ||
    t.includes("mechanic") ||
    t.includes("repair shop") ||
    t.includes("workshop") ||
    t.includes("shop near me") ||
    t.includes("nearby shop")
  );
}

export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text = body.text || "";
    const locale = inferLocale({ locale: body.locale, text });
    const user_location = body.user_location || "Global";

    // accept both keys
    const image_base_64 = body.image_base_64 || body.image_base64 || "";
    const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";
    const history = Array.isArray(body.history) ? body.history : [];

    // Pro / Web search flags (you control this from Flutter)
    const web_search =
      Boolean(body.web_search) || Boolean(body.enable_web_search) || Boolean(body.pro);

    // 1) transcribe audio (if any)
    const voiceText = await transcribeAudio(audio_base_64);
    const fullInput = `${text} ${voiceText}`.trim();

    // 2) Local verified search from /data
    const searchPack = await performSearch(fullInput, user_location);
    const VERIFIED_DATA = searchPack.verified_data || [];

    // 3) Workshops (Pro web search via Google Places) — only when:
    // - web_search enabled (Pro), AND
    // - user asks for workshops OR user location is meaningful
    let VERIFIED_WORKSHOPS = [];
    if (web_search && (wantsWorkshops(fullInput) || (user_location && user_location !== "Global"))) {
      const maxResults = Number(process.env.PLACES_MAX_RESULTS || 5);
      VERIFIED_WORKSHOPS = await searchPlacesWorkshops({
        userLocation: user_location,
        userText: fullInput,
        maxResults,
      });
    }

    // 4) Build user message content
    const messageContent = [];

    messageContent.push({
      type: "text",
      text: `STRICT_CONTEXT
LOCALE: ${locale}
LOCATION: ${user_location}

VERIFIED_DATA_JSON: ${JSON.stringify(VERIFIED_DATA)}
VERIFIED_WORKSHOPS_JSON: ${JSON.stringify(VERIFIED_WORKSHOPS)}

USER_INPUT: ${fullInput}`,
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
        ...history.slice(-6),
        { role: "user", content: messageContent },
      ],
      temperature: 0.15,
    });

    const out = response.choices?.[0]?.message?.content || "";
    return { ok: true, reply: out, locale, workshops_count: VERIFIED_WORKSHOPS.length };
  } catch (error) {
    console.error("FixLens Error:", error?.message || error);
    return { ok: false, reply: "System is under load. Please try again.", locale: "en" };
  }
}
