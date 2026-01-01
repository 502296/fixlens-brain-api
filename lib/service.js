import fetch from "node-fetch";
import { buildDoctorSystemPrompt } from "./doctorPrompt.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL_TEXT || "gpt-4o-mini";
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPER_URL = "https://google.serper.dev/search";

// ---------- helpers ----------
const isArabic = (t = "") => /[\u0600-\u06FF]/.test(t);

const lastUserMessage = (messages = []) =>
  [...messages].reverse().find(m => m.role === "user")?.content || "";

const isTestMessage = t =>
  ["PING_FIXLENS_SERVER", "TEST_ROUTE_123"].includes(t.trim());

const wantsSearch = t =>
  /price|buy|where|near|store|سعر|وين|قريب|اشتري|اوتوزون|اوريلي/i.test(t);

const wantsHowTo = t =>
  /how to|replace|fix|install|شلون|طريقة|تبديل|تصليح/i.test(t);

// ---------- OpenAI ----------
async function askOpenAI({ system, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------- Serper ----------
async function serperSearch(query, location) {
  if (!SERPER_API_KEY) return null;

  try {
    const res = await fetch(SERPER_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: query,
        gl: "us",
        location,
      }),
    });
    return await res.json();
  } catch {
    return null;
  }
}

// ---------- main ----------
export async function handleChat(body) {
  const messages = body.messages || [];
  const meta = body.meta || {};
  const userText = lastUserMessage(messages);

  // Guards
  if (isTestMessage(userText)) {
    return { ok: true, reply: "FixLens server is online and healthy." };
  }

  const lang = isArabic(userText) ? "ar" : "en";

  // ---------- SEARCH ----------
  if (wantsSearch(userText)) {
    if (!meta.zip && !meta.cityState) {
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "أرسل ZIP code أو المدينة حتى أبحث لك عن السعر والمكان."
            : "Please provide a ZIP code or city/state so I can search nearby prices.",
      };
    }

    const query = `${userText} ${meta.zip || meta.cityState}`;
    const searchData = await serperSearch(query, meta.zip || meta.cityState);

    if (!searchData) {
      return {
        ok: true,
        reply:
          lang === "ar"
            ? "البحث غير متاح حاليًا، لكن أقدر أشرح لك متوسط السعر وخيارات الشراء."
            : "Live search is unavailable, but I can explain typical prices and options.",
      };
    }

    const system = buildDoctorSystemPrompt({ outputLanguage: lang });
    const reply = await askOpenAI({
      system,
      messages: [
        {
          role: "user",
          content: `Summarize real stores and prices only from this data:\n${JSON.stringify(
            searchData
          )}`,
        },
      ],
    });

    return { ok: true, reply };
  }

  // ---------- HOW-TO (Consent Gate) ----------
  if (wantsHowTo(userText) && !meta?.consent?.accepted) {
    return {
      ok: true,
      needsConsent: true,
      reply:
        lang === "ar"
          ? "قبل إعطاء خطوات تصليح، لازم تأكيد إنك موافق وتفهم مخاطر السلامة."
          : "Before giving repair steps, I need your safety confirmation.",
    };
  }

  // ---------- NORMAL DIAGNOSIS ----------
  const system = buildDoctorSystemPrompt({ outputLanguage: lang });
  const reply = await askOpenAI({ system, messages });

  return { ok: true, reply };
}
