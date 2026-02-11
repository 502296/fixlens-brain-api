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
    return result.text;
  } catch (err) {
    console.error("Audio Error:", err.message);
    return "";
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export async function handleFixLensRequest(req) {
  try {
    const {
      text = "",
      image_base_64,
      audio_base_64,
      user_location = "Global",
      history = [],
    } = req.body;

    const voiceText = await transcribeAudio(audio_base_64);
    const fullInput = `${text} ${voiceText}`.trim();

    let searchResults = "";
    if (fullInput.length > 2) {
      searchResults = await performSearch(fullInput, user_location);
    }

    const messageContent = [
      {
        type: "text",
        text: `[STRICT GLOBAL CONTEXT]\nLOCATION: ${user_location}\nSEARCH_RESULTS: ${searchResults}\nUSER_INPUT: ${fullInput}`,
      },
    ];

    if (image_base_64) {
      messageContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${image_base_64}`,
          detail: "high",
        },
      });
      messageContent.push({
        type: "text",
        text: "DIAGNOSTIC TASK: Identify the specific car part and find the mechanical fault.",
      });
    }

    const response = await client.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: buildDoctorSystemPrompt() },
        ...history.slice(-3),
        { role: "user", content: messageContent },
      ],
      temperature: 0.1,
    });

    return { ok: true, reply: response.choices[0].message.content };
  } catch (error) {
    console.error("FixLens Final Brain Error:", error.message);
    return { ok: false, reply: "عذراً، النظام يواجه ضغطاً. حاول مجدداً." };
  }
}
