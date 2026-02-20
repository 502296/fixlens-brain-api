// service.js — FixLens Brain (Final Stable Build)
// Strict diagnosis vs Places separation
// Audio prioritized as mechanical sound
// No sticky Places bug
// No Arabic false location triggers

import OpenAI from "openai";
import { performSearch } from "./search.js";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* =========================================================
   LANGUAGE
========================================================= */
function detectLanguage(text = "") {
  const t = String(text || "");
  if (/[\u0600-\u06FF]/.test(t)) return "ar";
  if (/[\u3040-\u30FF]/.test(t)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(t)) return "zh";
  if (/[\uAC00-\uD7AF]/.test(t)) return "ko";
  return "en";
}

function resolveLocale(clientLocale, text) {
  const detected = detectLanguage(text);
  if (!clientLocale) return detected;
  const short = String(clientLocale).split("-")[0];
  if (short === "en" && detected !== "en") return detected;
  return short;
}

/* =========================================================
   PLACES INTENT (STRICT MODE — NO STICKY)
========================================================= */
function looksLikePlacesRequest(input = "") {
  const t = String(input).toLowerCase();

  const triggers = [
    "mechanic",
    "garage",
    "auto repair",
    "repair shop",
    "near me",
    "closest",
    "address",
    "location",
    "map",
    "google maps",
    "ورشة",
    "ميكانيك",
    "ميكانيكي",
    "كراج",
    "اقرب",
    "أقرب",
    "عنوان",
    "موقع",
    "خرائط",
    "وين اصلح",
    "اقرب ورشة"
  ];

  return triggers.some((w) => t.includes(w));
}

function containsSymptoms(text = "") {
  return /صوت|طقطقة|رجفة|اهتزاز|حرارة|دخان|engine|noise|vibration|brake|check/i.test(text);
}

/* =========================================================
   AUDIO POLICY
========================================================= */
function userExplicitlySaysRoad(text = "") {
  return /road|wheel|tire|tyre|alignment|balance|اطارات|إطارات|دركسون|ميزان|ترصيص/i.test(text);
}

async function transcribeAudio(audioBase64, locale, forceMechanical) {
  if (!audioBase64) return { text: "", type: "none" };

  const fs = await import("fs");
  const path = await import("path");

  const temp = path.join("/tmp", `a_${Date.now()}.m4a`);
  fs.writeFileSync(temp, Buffer.from(audioBase64, "base64"));

  try {
    const res = await client.audio.transcriptions.create({
      file: fs.createReadStream(temp),
      model: "whisper-1",
      language: locale,
    });

    const text = String(res?.text || "").trim();

    if (forceMechanical) {
      return { text: "", type: "mechanical" };
    }

    return { text, type: text ? "speech" : "mechanical" };
  } catch {
    return { text: "", type: "mechanical" };
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

/* =========================================================
   MAIN HANDLER
========================================================= */
export async function handleFixLensRequest(req) {
  const body = req.body || {};
  const text = String(body.text || "").trim();
  const audio_base_64 = body.audio_base_64 || "";
  const image_base_64 = body.image_base_64 || "";
  const clientLocale = body.locale;
  const user_location = body.user_location || "";

  const locale = resolveLocale(clientLocale, text);

  if (!text && !audio_base_64 && !image_base_64) {
    return {
      ok: false,
      reply: locale === "ar"
        ? "اكتب الأعراض أو أرسل صورة/صوت."
        : "Send symptoms or attach photo/audio."
    };
  }

  /* ===== AUDIO ===== */
  const forceMechanical =
    audio_base_64 && !userExplicitlySaysRoad(text);

  const audioResult = await transcribeAudio(
    audio_base_64,
    locale,
    forceMechanical
  );

  const fullInput =
    audioResult.type === "speech"
      ? `${text} ${audioResult.text}`
      : text;

  /* ===== STRICT PLACES MODE ===== */
  const typedPlaces = looksLikePlacesRequest(text);
  const hasSymptomsNow =
    containsSymptoms(text) ||
    audio_base_64 ||
    image_base_64;

  const placesIntent = typedPlaces && !hasSymptomsNow;

  /* ===== SEARCH ===== */
  const searchPack = await performSearch(fullInput, user_location, {
    locale,
    allowPlaces: placesIntent
  });

  const workshops = searchPack.verified_workshops || [];
  const verifiedData = searchPack.verified_data || [];

  /* ===== IF PLACES ===== */
  if (placesIntent) {
    if (!workshops.length) {
      return {
        ok: true,
        reply: locale === "ar"
          ? "ما لكيت نتائج. فعل GPS أو اكتب ZIP/المدينة."
          : "No nearby results. Enable GPS or send ZIP/City.",
      };
    }

    const formatted = workshops
      .slice(0, 5)
      .map((w, i) =>
        `${i + 1}) ${w.name}\n${w.address}\n${w.maps_url}`
      )
      .join("\n\n");

    return {
      ok: true,
      reply:
        locale === "ar"
          ? `هذه نتائج قريبة:\n\n${formatted}`
          : `Nearby results:\n\n${formatted}`,
    };
  }

  /* ===== DIAGNOSIS ===== */
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    temperature: 0.15,
    max_tokens: 800,
    messages: [
      { role: "system", content: buildDoctorSystemPrompt() },
      {
        role: "user",
        content: `
LOCALE: ${locale}
AUDIO_TYPE: ${audioResult.type}
USER_INPUT: ${fullInput}
VERIFIED_DATA: ${JSON.stringify(verifiedData)}
Rules:
- Respond ONLY in LOCALE language.
- If audio exists, treat as mechanical sound by default.
- Never assume road vibration unless user explicitly says.
- No filler. No generic menus.
- Pick ONE most likely cause.
`
      }
    ]
  });

  return {
    ok: true,
    reply: response.choices[0].message.content.trim(),
  };
}
