// service.js — FixLens Brain v8
// Unified global diagnostic orchestrator
// English-only code, one brain, multilingual output

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./memoryEngine.js";
import { buildResponsePlan } from "./responsePlanner.js";
import { buildEnginePack } from "./engineIntel.js";
import { detectIntent } from "./intentDetector.js";

import { processAudio } from "./audioProcessor.js";
import { performSearch } from "./search.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL =
  process.env.FIXLENS_MODEL ||
  "gpt-4o";

export async function handleFixLensRequest(req) {
  try {
    const body = req.body || {};

    const text =
      body.text ||
      body.message ||
      "";

    const history =
      Array.isArray(body.history)
        ? body.history
        : [];

    const image =
      body.image_base64 || "";

    const audio =
      body.audio_base64 || "";

    const location =
      body.user_location ||
      body.location ||
      body.gps ||
      body.latlng ||
      body.city ||
      body.zip ||
      null;

    let userText = text;

    /* -------------------------
       AUDIO PROCESSING
    ------------------------- */

    if (audio) {
      try {
        const audioText = await processAudio(audio);

        if (audioText && typeof audioText === "string" && audioText.trim()) {
          userText = audioText.trim();
        }
      } catch (error) {
        console.log("Audio processing failed:", error?.message || error);
      }
    }

    if (!userText || !String(userText).trim()) {
      return {
        reply: "Please describe what the vehicle is doing, when it happens, and what car or truck you have.",
        intent: "general"
      };
    }

    /* -------------------------
       RULE-BASED INTENT
    ------------------------- */

    let ruleIntent = {
      primaryIntent: "diagnosis",
      diagnosis: true,
      places: false,
      needsSearch: false,
      askForLocation: false,
      hasVehicleSymptom: true,
      hasLocationHint: false
    };

    try {
      ruleIntent = detectIntent({
        text: userText,
        history,
        location
      });
    } catch (error) {
      console.log("Intent detector failed:", error?.message || error);
    }

    /* -------------------------
       MODEL INTENT BRIDGE
       Language-agnostic classification
    ------------------------- */

    const modelIntent = await classifyIntentWithModel({
      text: userText,
      history,
      location,
      ruleIntent
    });

    const primaryIntent =
      modelIntent.primaryIntent ||
      ruleIntent.primaryIntent ||
      "diagnosis";

    const needsSearch =
      Boolean(modelIntent.needsSearch) ||
      Boolean(ruleIntent.needsSearch);

    const askForLocation =
      Boolean(modelIntent.askForLocation);

    const detectedLanguage =
      modelIntent.userLanguage ||
      "same-as-user";

    const detectedDialect =
      modelIntent.userDialect ||
      "natural-user-style";

    /* -------------------------
       MEMORY ENGINE
    ------------------------- */

    let memoryBlock = "";

    try {
      memoryBlock = buildDiagnosticMemory({
        text: userText,
        history
      });
    } catch (error) {
      console.log("Memory engine failed:", error?.message || error);
    }

    /* -------------------------
       ENGINE INTELLIGENCE
    ------------------------- */

    let engineIntel = "";

    try {
      engineIntel = buildEnginePack(userText);
    } catch (error) {
      console.log("Engine intel failed:", error?.message || error);
    }

    /* -------------------------
       SEARCH
    ------------------------- */

    let searchResults = "";
    let searchSummary = "none";

    try {
      const shouldSearch =
        needsSearch === true;

      if (shouldSearch) {
        const search = await performSearch({
          query: userText,
          location
        });

        if (search) {
          searchResults = JSON.stringify(search, null, 2);
          searchSummary = "available";
        }
      }
    } catch (error) {
      console.log("Search failed:", error?.message || error);
    }

    /* -------------------------
       RESPONSE PLAN
    ------------------------- */

    let responsePlan = "";

    try {
      responsePlan = buildResponsePlan({
        text: userText,
        intent: primaryIntent,
        memory: memoryBlock
      });
    } catch (error) {
      console.log("Response planner failed:", error?.message || error);
    }

    /* -------------------------
       SYSTEM PROMPT
    ------------------------- */

    const systemPrompt = buildDoctorSystemPrompt();

    /* -------------------------
       CONTEXT BLOCK
    ------------------------- */

    const contextBlock = `
Case Mode:
Unified global FixLens doctor

Detected User Language:
${detectedLanguage}

Detected User Dialect:
${detectedDialect}

Primary Intent:
${primaryIntent}

Needs Search:
${String(needsSearch)}

Ask For Location:
${String(askForLocation)}

Known Location Input:
${location ? JSON.stringify(location) : "none"}

User Problem:
${userText}

Memory:
${memoryBlock || "none"}

Engine Intelligence:
${engineIntel || "none"}

Search Results Status:
${searchSummary}

Search Results:
${searchResults || "none"}

Response Plan:
${responsePlan || "none"}
`.trim();

    /* -------------------------
       MESSAGES
    ------------------------- */

    let messages = [
      {
        role: "system",
        content: systemPrompt
      }
    ];

    if (history.length > 0) {
      messages = messages.concat(history);
    }

    if (image) {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: contextBlock
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${image}`
            }
          }
        ]
      });
    } else {
      messages.push({
        role: "user",
        content: contextBlock
      });
    }

    /* -------------------------
       OPENAI RESPONSE
    ------------------------- */

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.35,
      messages
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "I could not produce a reliable diagnostic answer.";

    return {
      reply,
      intent: primaryIntent,
      language: detectedLanguage,
      dialect: detectedDialect,
      searched: Boolean(searchResults)
    };
  } catch (error) {
    console.error("FixLens service error:", error);

    return {
      reply: "FixLens hit an internal error while analyzing this case.",
      intent: "error"
    };
  }
}

async function classifyIntentWithModel({
  text,
  history = [],
  location = null,
  ruleIntent = {}
}) {
  try {
    const condensedHistory = history
      .slice(-6)
      .map((item) => {
        const role = item?.role || "unknown";
        const content =
          typeof item?.content === "string"
            ? item.content
            : JSON.stringify(item?.content || "");
        return `${role}: ${content}`;
      })
      .join("\n");

    const classifierPrompt = `
You classify the user's latest vehicle-related request.
Use the same logic regardless of the language or dialect.
Do not create separate Arabic, English, or regional policies.

Return JSON only.

Required keys:
- primaryIntent: one of "diagnosis", "places", "hybrid", "general"
- needsSearch: boolean
- askForLocation: boolean
- userLanguage: short human-readable label
- userDialect: short human-readable label

Rules:
- "diagnosis" = the user mainly wants fault analysis or next checks
- "places" = the user mainly wants nearby shops, addresses, maps, towing, parts stores, or local help
- "hybrid" = the user wants both diagnosis and local help
- "general" = greeting, vague opener, or unclear request

needsSearch:
- true only when location-based help is actually requested
- false for pure diagnosis

askForLocation:
- true only when local help is requested but there is no usable city / zip / GPS / location in the request or provided location field
- false otherwise

userLanguage:
- identify the language of the user's latest message

userDialect:
- identify the nearest natural style or dialect when possible
- if unclear, keep it broad and simple
`.trim();

    const classifierInput = `
Latest user text:
${text}

Provided location field:
${location ? JSON.stringify(location) : "none"}

Recent history:
${condensedHistory || "none"}

Rule intent:
${JSON.stringify(ruleIntent)}
`.trim();

    const result = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: classifierPrompt
        },
        {
          role: "user",
          content: classifierInput
        }
      ]
    });

    const raw =
      result?.choices?.[0]?.message?.content?.trim() || "";

    const parsed = safeParseJson(raw);

    if (!parsed || typeof parsed !== "object") {
      return fallbackIntent(ruleIntent);
    }

    return {
      primaryIntent: normalizePrimaryIntent(parsed.primaryIntent),
      needsSearch: Boolean(parsed.needsSearch),
      askForLocation: Boolean(parsed.askForLocation),
      userLanguage: cleanShortText(parsed.userLanguage, "same-as-user"),
      userDialect: cleanShortText(parsed.userDialect, "natural-user-style")
    };
  } catch (error) {
    console.log("Model intent bridge failed:", error?.message || error);
    return fallbackIntent(ruleIntent);
  }
}

function fallbackIntent(ruleIntent = {}) {
  return {
    primaryIntent: normalizePrimaryIntent(ruleIntent.primaryIntent),
    needsSearch: Boolean(ruleIntent.needsSearch),
    askForLocation: Boolean(ruleIntent.askForLocation),
    userLanguage: "same-as-user",
    userDialect: "natural-user-style"
  };
}

function normalizePrimaryIntent(value) {
  const allowed = new Set([
    "diagnosis",
    "places",
    "hybrid",
    "general"
  ]);

  if (typeof value !== "string") {
    return "diagnosis";
  }

  const normalized = value.trim().toLowerCase();

  if (allowed.has(normalized)) {
    return normalized;
  }

  return "diagnosis";
}

function cleanShortText(value, fallback) {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return fallback;
  }

  return trimmed.slice(0, 60);
}

function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    const sliced = raw.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(sliced);
    } catch {
      return null;
    }
  }
}
