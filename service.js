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
        "Car engine diagnostic sounds: knocking, squealing, ticking, engine fault.",
    });
    return result.text || "";
  } catch (err) {
    console.error("Audio Error:", err?.message || err);
    return "";
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
  }
}

function normalizeHistory(history) {
  // Expect array of {role, content}. We'll keep last 3 if valid.
  if (!Array.isArray(history)) return [];
  const cleaned = history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-3)
    .map((m) => ({ role: m.role, content: m.content }));
  return cleaned;
}

export async function handleFixLensRequest(req) {
  try {
    const {
      text = "",
      image_base_64,
      audio_base_64,
      user_location = "Global",
      history = [],
    } = req.body || {};

    // ✅ Voice -> text
    const voiceText = await transcribeAudio(audio_base_64);
    const fullInput = `${text} ${voiceText}`.trim();

    // ✅ Local data search (cheap)
    let searchResults = "";
    if (fullInput.length > 2) {
      searchResults = await performSearch(fullInput, user_location);
    }

    const messageContent = [
      {
        type: "text",
        text:
          `[STRICT GLOBAL CONTEXT]\n` +
          `LOCATION: ${user_location}\n` +
          `LOCAL_DATA: ${searchResults || "NONE"}\n` +
          `USER_INPUT: ${fullInput || "(empty)"}`
      },
    ];

    // ✅ Vision
    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${image_base_64}`, detail: "high" },
      });
      messageContent.push({
        type: "text",
        text: "DIAGNOSTIC TASK: Identify the specific car part and find the mechanical fault.",
      });
    }

    const cleanedHistory = normalizeHistory(history);

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        ...cleanedHistory,
        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    return { ok: true, reply: response.choices?.[0]?.message?.content || "" };
  } catch (error) {
    console.error("FixLens Final Brain Error:", error?.message || error);
    return {
      ok: false,
      reply: "عذراً، النظام يواجه ضغطاً حالياً. حاول مجدداً بعد قليل.",
    };
  }
}
