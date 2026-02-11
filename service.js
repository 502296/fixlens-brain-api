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
      prompt:
        "Vehicle diagnostic sounds: knocking, squealing, ticking, misfire, belt slip, bearing, wheel hub, brake squeal, injector tick, turbo whine.",
    });
    return (result.text || "").trim();
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return "";
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

function safeText(v) {
  return (v ?? "").toString().trim();
}

function mapHistoryTurns(history = []) {
  // Flutter sends: {role:'user'|'assistant', content:'...'}
  // OpenAI expects: {role:'user'|'assistant'|'system', content:'...'}
  if (!Array.isArray(history)) return [];
  return history
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
    .slice(-6)
    .map((t) => ({ role: t.role, content: safeText(t.content) }));
}

function detectIfUserAskedLocal(userText) {
  const t = (userText || "").toLowerCase();
  return (
    t.includes("near me") ||
    t.includes("nearest") ||
    t.includes("workshop") ||
    t.includes("garage") ||
    t.includes("mechanic") ||
    t.includes("ورشة") ||
    t.includes("ميكانيك") ||
    t.includes("قريب") ||
    t.includes("بالقرب")
  );
}

export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text = safeText(body.text);
    const imageBase64 = body.image_base64 || body.image_base_64 || null;
    const audioBase64 = body.audio_base_64 || body.audio_base64 || null;

    const userLocation = safeText(body.user_location) || "Global";
    const history = mapHistoryTurns(body.history || []);

    // 1) Audio -> text
    const voiceText = await transcribeAudio(audioBase64);
    const fullInput = safeText(`${text} ${voiceText}`).trim();

    // 2) Local data search (cheap) ALWAYS first if we have meaningful input
    let searchResults = "";
    if (fullInput.length >= 3) {
      searchResults = await performSearch(fullInput, userLocation);
    }

    // 3) Web search (Pro feature) — OFF by default
    // Later: only enable when PRO + user asked local + local data insufficient
    // Example toggle:
    // const isPro = body.isPro === true;
    // if (isPro && detectIfUserAskedLocal(fullInput) && !searchResults) { ... call external Web Search ... }
    //
    // IMPORTANT: Do NOT invent workshops without verified web/place results.

    const messageContent = [];

    messageContent.push({
      type: "text",
      text:
        `[STRICT_GLOBAL_CONTEXT]\n` +
        `LOCATION: ${userLocation}\n` +
        `SEARCH_RESULTS: ${searchResults || ""}\n` +
        `USER_INPUT: ${fullInput || ""}`,
    });

    if (imageBase64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${imageBase64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text: "DIAGNOSTIC TASK: Identify the exact vehicle component and failure mechanism from the photo.",
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        ...history,
        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    const reply = response?.choices?.[0]?.message?.content || "";
    return { ok: true, reply };
  } catch (error) {
    console.error("FixLens Brain Error:", error?.message || error);
    return { ok: false, reply: "Sorry — FixLens is under load. Please try again." };
  }
}
