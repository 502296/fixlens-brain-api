// service.js
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { performSearch } from "./search.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LOCATION FIX (CRITICAL – prevents "Global" search bug)
========================================================= */
function normalizeUserLocation(raw) {
  if (!raw) return "";
  if (typeof raw === "string") {
    const v = raw.trim();
    if (!v) return "";
    if (v.toLowerCase() === "global") return "";
    return v;
  }
  if (typeof raw === "object") return raw;
  return "";
}

/* =========================================================
   LANGUAGE DETECTION (unchanged logic, cleaner structure)
========================================================= */
function detectTextLanguage(text = "") {
  const t = String(text || "");

  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u0400-\u04FF]/.test(t)) return "ru";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";

  return "en";
}

function normalizeLocale(input) {
  const v = String(input || "").trim();
  if (!v || v.toLowerCase() === "auto") return "";
  return v;
}

function inferLocale({ locale, text }) {
  const normalized = normalizeLocale(locale);
  if (normalized) return normalized;
  return detectTextLanguage(text || "") || "en";
}

/* =========================================================
   RETRY + TIMEOUT (unchanged core reliability)
========================================================= */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ]);
}

async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(200 * (i + 1));
    }
  }
  throw lastErr;
}

/* =========================================================
   AUDIO TRANSCRIPTION
========================================================= */
async function transcribeAudio(audioBase64) {
  if (!audioBase64 || audioBase64.length < 50)
    return { text: "", ok: false };

  const tempPath = path.join("/tmp", `v_${Date.now()}.m4a`);
  try {
    fs.writeFileSync(tempPath, Buffer.from(audioBase64, "base64"));

    const result = await withRetry(() =>
      withTimeout(
        client.audio.transcriptions.create({
          file: fs.createReadStream(tempPath),
          model: "whisper-1",
        }),
        15000
      )
    );

    return { text: result?.text?.trim() || "", ok: true };
  } catch (err) {
    console.error("Audio Error:", err?.message);
    return { text: "", ok: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

/* =========================================================
   INTENT DETECTION
========================================================= */
function looksLikePlacesRequest(input = "") {
  const t = String(input || "").toLowerCase();
  return (
    t.includes("ورشة") ||
    t.includes("garage") ||
    t.includes("mechanic") ||
    t.includes("near me") ||
    t.includes("اقرب") ||
    t.includes("عنوان")
  );
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = body.text || "";
  const history = Array.isArray(body.history) ? body.history : [];

  let locale = inferLocale({ locale: body.locale, text });

  /* ===== FIXED LOCATION ===== */
  const user_location = normalizeUserLocation(body.user_location);
  const effective_location =
    typeof user_location === "object"
      ? user_location
      : user_location || "";

  const image_base_64 = body.image_base_64 || body.image_base64 || "";
  const audio_base_64 = body.audio_base_64 || body.audio_base64 || "";

  try {
    /* ===== AUDIO ===== */
    const audioResult = await transcribeAudio(audio_base_64);
    const voiceText = audioResult.text;

    const fullInput = `${text} ${voiceText}`.trim();

    /* ===== FIXED: voice can trigger places ===== */
    const placesIntent =
      looksLikePlacesRequest(fullInput);

    /* ===== SEARCH ===== */
    const searchPack = await withRetry(() =>
      withTimeout(
        performSearch(fullInput || text, user_location, {
          locale,
          allowPlaces: placesIntent,
        }),
        15000
      )
    );

    const VERIFIED_DATA = searchPack?.verified_data || [];
    const VERIFIED_WORKSHOPS = searchPack?.verified_workshops || [];

    /* ===== DIRECT WORKSHOP RESPONSE ===== */
    if (placesIntent) {
      if (VERIFIED_WORKSHOPS.length === 0) {
        return {
          ok: true,
          reply:
            locale === "ar"
              ? "لم أجد ورش قريبة حالياً. تأكد من تفعيل GPS أو أرسل المدينة/المنطقة."
              : "No nearby workshops found. Please enable GPS or send city/area.",
          locale,
          workshops_count: 0,
        };
      }

      const list = VERIFIED_WORKSHOPS.slice(0, 5)
        .map(
          (w, i) =>
            `${i + 1}) ${w.name}\n${w.address || ""}\n${w.maps_url || ""}`
        )
        .join("\n\n");

      return {
        ok: true,
        reply:
          locale === "ar"
            ? `هذه أقرب ورش حسب موقعك:\n\n${list}`
            : `Here are nearby workshops:\n\n${list}`,
        locale,
        workshops_count: VERIFIED_WORKSHOPS.length,
      };
    }

    /* ===== DIAGNOSTIC MODE ===== */
    const response = await withRetry(() =>
      withTimeout(
        client.chat.completions.create({
          model: process.env.FIXLENS_MODEL || "gpt-4o",
          messages: [
            { role: "system", content: buildDoctorSystemPrompt() },
            ...history.slice(-6),
            {
              role: "user",
              content: `LOCALE:${locale}\nINPUT:${fullInput}`,
            },
          ],
          temperature: 0.15,
          max_tokens: 900,
        }),
        25000
      )
    );

    const reply =
      response?.choices?.[0]?.message?.content?.trim() ||
      (locale === "ar"
        ? "حدث خلل مؤقت، أعد المحاولة."
        : "Temporary issue, please retry.");

    return {
      ok: true,
      reply,
      locale,
      workshops_count: VERIFIED_WORKSHOPS.length,
    };
  } catch (error) {
    console.error("FixLens Fatal:", error?.message);
    return {
      ok: false,
      reply:
        locale === "ar"
          ? "حدث خطأ مؤقت، أعد المحاولة."
          : "Temporary error, please retry.",
      locale,
      workshops_count: 0,
    };
  }
}
