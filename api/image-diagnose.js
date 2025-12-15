// api/image-diagnose.js
import OpenAI from "openai";
import { findRelevantIssues } from "../lib/autoKnowledge.js";
import { buildSystemPrompt } from "../lib/prompt.js";
import { parseMultipart, config as multipartConfig } from "./_multipart.js";

export const config = { ...multipartConfig, runtime: "nodejs18.x" };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

    const { fields, files, readFileBuffer } = await parseMultipart(req);

    const preferredLanguage = fields?.preferredLanguage || "auto";
    const message = (fields?.message || "").toString();

    const imageFile = files?.image;
    if (!imageFile) return res.status(400).json({ error: "Image file is required (field name: image)" });

    const buf = readFileBuffer(imageFile);
    const mime = imageFile.mimetype || "image/jpeg";
    const base64 = buf.toString("base64");
    const dataUrl = `data:${mime};base64,${base64}`;

    // نستخدم الـ message كـ سياق + نطلع autoKnowledge منه
    const issues = findRelevantIssues(message || "");

    const system = buildSystemPrompt(preferredLanguage);

    const out = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: system,
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: message?.trim() ? `Context from user: ${message}` : "Analyze this vehicle image." },
            { type: "input_text", text: `Relevant issues DB (if any): ${JSON.stringify(issues, null, 2)}` },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      temperature: 0.35,
    });

    const reply = (out.output_text || "").trim();
    return res.status(200).json({ reply: reply || "No reply." });
  } catch (e) {
    return res.status(500).json({
      error: "Image diagnosis failed",
      details: e?.message || String(e),
    });
  }
}
