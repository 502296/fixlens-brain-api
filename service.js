// service.js — FixLens Brain v10
// Unified global diagnostic orchestrator
// English-only code, one brain, multilingual output

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./memoryEngine.js";
import { buildResponsePlan } from "./responsePlanner.js";
import { buildEnginePack } from "./engineIntel.js";
import { detectIntent } from "./intentDetector.js";
import { resolveIntent } from "./intentRouter.js";

import { processAudio } from "./audioProcessor.js";
import { performSearch } from "./search.js";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MODEL =
  process.env.FIXLENS_MODEL ||
  "gpt-4o";

/* =========================================================
   MAIN
========================================================= */
export async function handleFixLensRequest(req) {
  try {
    const body = req?.body || {};

    const rawText = extractUserText(body);
    const history = normalizeHistory(body);
    const image = extractImage(body);
    const audio = extractAudio(body);

    const location =
      body.user_location ||
      body.location ||
      body.gps ||
      body.latlng ||
      body.coordinates ||
      body.city ||
      body.zip ||
      null;

    const locale =
      String(body.locale || body.lang || body.language || "auto").trim() || "auto";

    let userText = rawText;
    let audioTranscript = "";
    let audioContext = {
      used_audio: false,
      transcript_used: false,
      audio_kind: body.audio_kind || body.audio_type || "unknown",
    };

    /* -------------------------
       AUDIO PROCESSING
    ------------------------- */
    if (audio) {
      try {
        const audioResult = await processAudio(audio);

        if (typeof audioResult === "string" && audioResult.trim()) {
          audioTranscript = audioResult.trim();
        } else if (
          audioResult &&
          typeof audioResult === "object" &&
          typeof audioResult.text === "string" &&
          audioResult.text.trim()
        ) {
          audioTranscript = audioResult.text.trim();
        }

        if (audioTranscript) {
          audioContext = {
            used_audio: true,
            transcript_used: true,
            audio_kind:
              body.audio_kind ||
              body.audio_type ||
              audioResult?.audio_kind ||
              "speech_or_vehicle_audio",
          };

          if (!hasMeaningfulText(userText)) {
            userText = audioTranscript;
          } else if (!normalizeText(userText).includes(normalizeText(audioTranscript))) {
            userText = `${userText}\n\n[Audio transcript]\n${audioTranscript}`;
          }
        }
      } catch (error) {
        console.log("Audio processing failed:", error?.message || error);
      }
    }

    /* -------------------------
       EMPTY INPUT HANDLING
    ------------------------- */
    if (!hasMeaningfulText(userText) && !image) {
      return {
        ok: true,
        reply:
          "Please describe what the vehicle is doing, when it happens, and what car or truck you have.",
        intent: "general",
        language: "same-as-user",
        dialect: "natural-user-style",
        searched: false,
      };
    }

    /* -------------------------
       RULE + ROUTER INTENT
    ------------------------- */
    let ruleIntent = {
      primaryIntent: "diagnosis",
      diagnosis: true,
      places: false,
      purchase: false,
      safety: false,
      image: Boolean(image),
      audio: Boolean(audio),
      needsSearch: false,
      askForLocation: false,
      hasVehicleSymptom: true,
      hasLocationHint: false,
      diagnosisMode: "symptom_diagnosis",
      detectedCodes: [],
      languageProfile: {
        script: "unknown",
        mixed_script: false,
        reply_same_language: true,
      },
      intentConfidence: 0.4,
    };

    try {
      ruleIntent = detectIntent({
        text: userText,
        history,
        location,
      });
    } catch (error) {
      console.log("Intent detector failed:", error?.message || error);
    }

    let routedIntent = {
      mode: "general_question",
      isDiagnosis: true,
      isFollowup: false,
      isActionQuestion: false,
      isPlaces: false,
      isPurchase: false,
      isSafety: false,
      explicitPlaces: false,
      explicitPlacesHandoff: false,
      locationProvided: Boolean(location),
      locationAskedPreviously: false,
      hasDiagnosisContext: Boolean(ruleIntent?.diagnosis),
      hasPlacesContext: Boolean(ruleIntent?.places),
      hasImage: Boolean(image),
      hasAudio: Boolean(audio),
      imageTextHint: Boolean(ruleIntent?.image),
      audioTextHint: Boolean(ruleIntent?.audio),
      explanationOnly: false,
      detectedCodes: Array.isArray(ruleIntent?.detectedCodes)
        ? ruleIntent.detectedCodes
        : [],
      shouldUseGpsOrLocation: Boolean(ruleIntent?.places),
      shouldPreserveDiagnosisState: true,
      shouldMergeMediaIntoCase: Boolean(image || audio),
      localSearchType: null,
      route_confidence: 0.4,
    };

    try {
      routedIntent = resolveIntent({
        text: userText,
        history,
        hasImage: Boolean(image),
        hasAudio: Boolean(audio),
      });
    } catch (error) {
      console.log("Intent router failed:", error?.message || error);
    }

    /* -------------------------
       MODEL INTENT BRIDGE
       Language-agnostic classification
    ------------------------- */
    const modelIntent = await classifyIntentWithModel({
      text: userText,
      history,
      location,
      locale,
      ruleIntent,
      routedIntent,
      hasImage: Boolean(image),
      hasAudio: Boolean(audio),
    });

    const primaryIntent =
      modelIntent.primaryIntent ||
      ruleIntent.primaryIntent ||
      (routedIntent.isPlaces ? "places" : "diagnosis");

    const detectedLanguage =
      modelIntent.userLanguage ||
      "same-as-user";

    const detectedDialect =
      modelIntent.userDialect ||
      "natural-user-style";

    const searchNeededByIntent =
      Boolean(modelIntent.needsSearch) ||
      Boolean(ruleIntent.needsSearch) ||
      Boolean(routedIntent.isPlaces) ||
      Boolean(routedIntent.mode === "places_handoff_from_diagnosis");

    const askForLocation =
      Boolean(modelIntent.askForLocation) ||
      (Boolean(routedIntent.shouldUseGpsOrLocation) &&
        !Boolean(routedIntent.locationProvided) &&
        !Boolean(ruleIntent.hasLocationHint) &&
        !hasUsableLocation(location, userText));

    /* -------------------------
       MEMORY ENGINE
    ------------------------- */
    let memory = {
      current_case_summary: {},
      case_direction: "general_diagnosis",
      memory_text: "none",
    };

    try {
      memory = buildDiagnosticMemory({
        text: userText,
        history,
        voiceText: audioTranscript,
        audioType: audioContext.used_audio ? audioContext.audio_kind : "none",
      });
    } catch (error) {
      console.log("Memory engine failed:", error?.message || error);
    }

    /* -------------------------
       ENGINE INTELLIGENCE
    ------------------------- */
    let enginePack = {
      make: null,
      model: null,
      year: null,
      detected_engine: null,
      detected_fault_codes: [],
      simple_engine_issue_matches: [],
      intel_best_pattern: null,
      prepurchase_risk: "low",
      vehicle_identity: null,
      intel_score: 0,
    };

    try {
      const memoryVehicle = memory?.current_case_summary?.vehicle || {};
      const enrichedText = enrichTextWithVehicle(userText, memoryVehicle);
      enginePack = buildEnginePack(enrichedText);
    } catch (error) {
      console.log("Engine intel failed:", error?.message || error);
    }

    /* -------------------------
       SEARCH
    ------------------------- */
    let search = {
      verified_data: [],
      verified_actions: [],
      verified_workshops: [],
      search_meta: {},
    };

    try {
      if (searchNeededByIntent) {
        search = await performSearch(userText, location, {
          locale,
          allowPlaces: Boolean(
            routedIntent.isPlaces ||
            primaryIntent === "places" ||
            primaryIntent === "hybrid"
          ),
          forcePlaces: Boolean(
            routedIntent.isPlaces ||
            routedIntent.mode === "places_handoff_from_diagnosis"
          ),
          maxResults: 4,
        });
      } else {
        search = await performSearch(userText, location, {
          locale,
          allowPlaces: false,
          forcePlaces: false,
          maxResults: 4,
        });
      }
    } catch (error) {
      console.log("Search failed:", error?.message || error);
    }

    const verifiedData = Array.isArray(search?.verified_data)
      ? search.verified_data
      : [];

    const verifiedActions = Array.isArray(search?.verified_actions)
      ? search.verified_actions
      : [];

    const verifiedWorkshops = Array.isArray(search?.verified_workshops)
      ? search.verified_workshops
      : [];

    const searchMeta =
      search?.search_meta && typeof search.search_meta === "object"
        ? search.search_meta
        : {};

    /* -------------------------
       RESPONSE PLAN
    ------------------------- */
    let responsePlan = {
      severity: "medium",
      domain: "general",
      cluster: "",
      strongest_hypothesis: "general mechanical fault path still needs narrowing",
      likely_causes: [],
      likely_cause_reasons: [],
      tests: [],
      must_ask: [],
      needs_search: false,
      query: "",
      workshop_query: "",
      safety_advice: "",
      purchase_judgment: "",
      codes: [],
      evidence_summary: [],
      media_hints: {},
      user_intent: {},
      planner_text: "none",
    };

    try {
      responsePlan = buildResponsePlan({
        locale,
        text: userText,
        placesIntent: Boolean(routedIntent.isPlaces),
        enginePack,
        diagnosticMemory: memory,
        verifiedData,
        verifiedWorkshops,
        internalIntelStrong: Number(enginePack?.intel_score || 0) >= 8,
      });
    } catch (error) {
      console.log("Response planner failed:", error?.message || error);
    }

    /* -------------------------
       LOCATION GATE
    ------------------------- */
    if (
      askForLocation &&
      !hasUsableLocation(location, userText)
    ) {
      const locationPrompt = buildLocationPrompt({
        language: detectedLanguage,
        dialect: detectedDialect,
        primaryIntent,
        routedIntent,
      });

      return {
        ok: true,
        reply: locationPrompt,
        intent: primaryIntent,
        language: detectedLanguage,
        dialect: detectedDialect,
        searched: false,
        needs_location: true,
      };
    }

    /* -------------------------
       SYSTEM PROMPT
    ------------------------- */
    const systemPrompt = buildDoctorSystemPrompt();

    /* -------------------------
       CONTEXT BLOCK
    ------------------------- */
    const contextBlock = buildUnifiedContextBlock({
      locale,
      detectedLanguage,
      detectedDialect,
      primaryIntent,
      ruleIntent,
      routedIntent,
      location,
      userText,
      rawText,
      audioTranscript,
      audioContext,
      memory,
      enginePack,
      responsePlan,
      verifiedData,
      verifiedActions,
      verifiedWorkshops,
      searchMeta,
    });

    /* -------------------------
       MESSAGES
    ------------------------- */
    const messages = buildOpenAIMessages({
      systemPrompt,
      history,
      contextBlock,
      image,
    });

    /* -------------------------
       OPENAI RESPONSE
    ------------------------- */
    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.25,
      messages,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "I could not produce a reliable diagnostic answer.";

    return {
      ok: true,
      reply,
      intent: primaryIntent,
      language: detectedLanguage,
      dialect: detectedDialect,
      searched:
        verifiedData.length > 0 ||
        verifiedActions.length > 0 ||
        verifiedWorkshops.length > 0,
      debug: body?.debug
        ? {
            route_mode: routedIntent.mode,
            diagnosis_mode: ruleIntent?.diagnosisMode || null,
            engine_identity: enginePack?.vehicle_identity || null,
            strongest_hypothesis: responsePlan?.strongest_hypothesis || null,
            local_search_type: routedIntent?.localSearchType || null,
            codes: responsePlan?.codes || [],
            matched_action_ids: verifiedActions.map((x) => x?.id).filter(Boolean),
          }
        : undefined,
    };
  } catch (error) {
    console.error("FixLens service error:", error);

    return {
      ok: false,
      reply: "FixLens hit an internal error while analyzing this case.",
      intent: "error",
      language: "same-as-user",
      dialect: "natural-user-style",
    };
  }
}

/* =========================================================
   MODEL INTENT BRIDGE
========================================================= */
async function classifyIntentWithModel({
  text,
  history = [],
  location = null,
  locale = "auto",
  ruleIntent = {},
  routedIntent = {},
  hasImage = false,
  hasAudio = false,
}) {
  try {
    const condensedHistory = (Array.isArray(history) ? history : [])
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
Use the same logic regardless of language, dialect, or script.
Do not create separate Arabic, English, or regional policies.

Return JSON only.

Required keys:
- primaryIntent: one of "diagnosis", "places", "hybrid", "general"
- needsSearch: boolean
- askForLocation: boolean
- userLanguage: short human-readable label
- userDialect: short human-readable label

Rules:
- "diagnosis" = the user mainly wants diagnosis, fault analysis, next checks, code analysis, image dashboard reading, audio/noise interpretation, safety judgment, or pre-purchase technical judgment
- "places" = the user mainly wants nearby shops, addresses, maps, towing, parts stores, or local help
- "hybrid" = the user wants both diagnosis and local help
- "general" = greeting, vague opener, or unclear request

needsSearch:
- true when nearby help, workshop lookup, parts store lookup, towing, or local action is needed
- false for pure diagnosis unless local help is clearly part of the request

askForLocation:
- true only when local help is needed but there is no usable city / zip / GPS / location in the request or provided location field
- false otherwise

userLanguage:
- identify the user's current language

userDialect:
- identify the nearest natural dialect or style if clear
- otherwise keep it broad
`.trim();

    const classifierInput = `
Latest user text:
${text}

Provided location field:
${location ? JSON.stringify(location) : "none"}

Locale field:
${locale}

Has image:
${String(Boolean(hasImage))}

Has audio:
${String(Boolean(hasAudio))}

Recent history:
${condensedHistory || "none"}

Rule intent:
${JSON.stringify(ruleIntent)}

Router intent:
${JSON.stringify(routedIntent)}
`.trim();

    const result = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: classifierPrompt,
        },
        {
          role: "user",
          content: classifierInput,
        },
      ],
    });

    const raw =
      result?.choices?.[0]?.message?.content?.trim() || "";

    const parsed = safeParseJson(raw);

    if (!parsed || typeof parsed !== "object") {
      return fallbackIntent(ruleIntent, routedIntent);
    }

    return {
      primaryIntent: normalizePrimaryIntent(parsed.primaryIntent, routedIntent),
      needsSearch: Boolean(parsed.needsSearch),
      askForLocation: Boolean(parsed.askForLocation),
      userLanguage: cleanShortText(parsed.userLanguage, "same-as-user"),
      userDialect: cleanShortText(parsed.userDialect, "natural-user-style"),
    };
  } catch (error) {
    console.log("Model intent bridge failed:", error?.message || error);
    return fallbackIntent(ruleIntent, routedIntent);
  }
}

/* =========================================================
   HELPERS
========================================================= */
function extractUserText(body = {}) {
  if (!body) return "";

  if (typeof body.text === "string") return body.text;
  if (typeof body.message === "string") return body.message;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.input === "string") return body.input;
  if (typeof body.query === "string") return body.query;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];

    if (typeof last?.content === "string") return last.content;

    if (Array.isArray(last?.content)) {
      const textPart = last.content.find((c) => c?.type === "text")?.text;
      if (typeof textPart === "string") return textPart;
    }
  }

  return "";
}

function extractImage(body = {}) {
  return (
    body.image_base64 ||
    body.image_base_64 ||
    body.image ||
    ""
  );
}

function extractAudio(body = {}) {
  return (
    body.audio_base64 ||
    body.audio_base_64 ||
    body.audio ||
    ""
  );
}

function normalizeHistory(body = {}) {
  if (Array.isArray(body.history)) return body.history;
  if (Array.isArray(body.messages)) {
    return body.messages.filter((m) => m?.role === "user" || m?.role === "assistant");
  }
  return [];
}

function hasMeaningfulText(value = "") {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-zA-Z0-9\s\-\.\,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUsableLocation(location, text = "") {
  if (!location && !text) return false;

  if (location) {
    if (typeof location === "string" && location.trim().length >= 3) return true;

    if (typeof location === "object" && !Array.isArray(location)) {
      const lat = Number(location.lat ?? location.latitude);
      const lng = Number(location.lng ?? location.longitude ?? location.lon);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return true;

      const city =
        location.city ||
        location.locality ||
        location.town ||
        location.name ||
        location.region ||
        location.state ||
        location.country;
      if (typeof city === "string" && city.trim().length >= 2) return true;
    }
  }

  const t = String(text || "").trim();
  if (!t) return false;

  if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true;
  if (/(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t)) return true;

  return false;
}

function normalizePrimaryIntent(value, routedIntent = {}) {
  const allowed = new Set(["diagnosis", "places", "hybrid", "general"]);

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (allowed.has(normalized)) return normalized;
  }

  if (routedIntent?.isPlaces && routedIntent?.isDiagnosis) return "hybrid";
  if (routedIntent?.isPlaces) return "places";
  if (routedIntent?.isDiagnosis) return "diagnosis";

  return "diagnosis";
}

function cleanShortText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 60);
}

function safeParseJson(raw) {
  if (!raw || typeof raw !== "string") return null;

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

function fallbackIntent(ruleIntent = {}, routedIntent = {}) {
  return {
    primaryIntent: normalizePrimaryIntent(
      ruleIntent.primaryIntent,
      routedIntent
    ),
    needsSearch:
      Boolean(ruleIntent.needsSearch) || Boolean(routedIntent.isPlaces),
    askForLocation:
      Boolean(ruleIntent.askForLocation) ||
      (Boolean(routedIntent.isPlaces) && !Boolean(routedIntent.locationProvided)),
    userLanguage: "same-as-user",
    userDialect: "natural-user-style",
  };
}

function enrichTextWithVehicle(text = "", vehicle = {}) {
  const prefix = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!prefix) return text || "";
  return `${prefix}\n${text || ""}`.trim();
}

function formatSearchDataForContext(items = [], maxItems = 4) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((item, i) => ({
      index: i + 1,
      title: item?.title || item?.name || "Item",
      score: item?.score ?? null,
      source: item?.source || "",
      causes: item?.causes || "",
      checks: item?.checks || "",
      steps: item?.steps || "",
      tags: item?.tags || "",
      codes: item?.codes || [],
      address: item?.address || "",
      rating: item?.rating ?? null,
      phone: item?.phone || "",
      maps_url: item?.maps_url || "",
      primary_type: item?.primary_type || "",
      mode: item?.mode || "",
    }));
}

function formatVerifiedActionsForContext(items = [], maxItems = 4) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((item, i) => ({
      index: i + 1,
      id: item?.id || "",
      match_score: item?.match_score ?? null,
      diagnostic_priority: item?.diagnostic_priority ?? null,
      safety_level: item?.safety_level || "",
      match_type: item?.match_type || [],
      confidence_boost_if: item?.confidence_boost_if || [],
      kill_other_hypotheses: item?.kill_other_hypotheses || [],
      actions: item?.actions || [],
      stop_now_if: item?.stop_now_if || [],
      ignore_risk: item?.ignore_risk || "",
      source: item?.source || "",
    }));
}

function buildUnifiedContextBlock({
  locale,
  detectedLanguage,
  detectedDialect,
  primaryIntent,
  ruleIntent,
  routedIntent,
  location,
  userText,
  rawText,
  audioTranscript,
  audioContext,
  memory,
  enginePack,
  responsePlan,
  verifiedData,
  verifiedActions,
  verifiedWorkshops,
  searchMeta,
}) {
  return `
FIXLENS_CASE_CONTEXT:
LOCALE=${JSON.stringify(locale || "auto")}
DETECTED_USER_LANGUAGE=${JSON.stringify(detectedLanguage || "same-as-user")}
DETECTED_USER_DIALECT=${JSON.stringify(detectedDialect || "natural-user-style")}
PRIMARY_INTENT=${JSON.stringify(primaryIntent || "diagnosis")}
ROUTER_MODE=${JSON.stringify(routedIntent?.mode || "unknown")}
RULE_INTENT=${JSON.stringify(ruleIntent || {})}
ROUTED_INTENT=${JSON.stringify(routedIntent || {})}
KNOWN_LOCATION_INPUT=${location ? JSON.stringify(location) : "none"}

RAW_USER_TEXT=${JSON.stringify(rawText || "")}
UNIFIED_USER_TEXT=${JSON.stringify(userText || "")}
AUDIO_TRANSCRIPT=${JSON.stringify(audioTranscript || "")}
AUDIO_CONTEXT=${JSON.stringify(audioContext || {})}

MEMORY_TEXT:
${memory?.memory_text || "none"}

ENGINE_PACK:
${JSON.stringify(enginePack || {}, null, 2)}

RESPONSE_PLAN:
${responsePlan?.planner_text || "none"}

SEARCH_META:
${JSON.stringify(searchMeta || {}, null, 2)}

VERIFIED_INTERNAL_DATA:
${JSON.stringify(formatSearchDataForContext(verifiedData, 4), null, 2)}

VERIFIED_ACTIONS:
${JSON.stringify(formatVerifiedActionsForContext(verifiedActions, 4), null, 2)}

VERIFIED_LOCAL_RESULTS:
${JSON.stringify(formatSearchDataForContext(verifiedWorkshops, 5), null, 2)}

FINAL_ORCHESTRATION_RULES:
- Reply in the user's current language naturally and keep that language locked unless the user switches.
- Think as one senior mechanic, not as separate modules.
- If multiple codes or clues point to one subsystem, lead with the central fault path.
- Use MEMORY_TEXT to avoid restarting the case.
- Use ENGINE_PACK to improve vehicle-specific reasoning.
- Use RESPONSE_PLAN to structure diagnosis, severity, next tests, safety, and purchase judgment.
- Use VERIFIED_INTERNAL_DATA to refine diagnosis when relevant.
- Use VERIFIED_ACTIONS as execution-grade decision support when they match the case strongly.
- If VERIFIED_ACTIONS contains a strong match, use its actions, stop_now_if, and ignore_risk intelligently.
- Use VERIFIED_LOCAL_RESULTS only when local help is requested or clearly useful.
- If nearby help is requested and local results are available, present the strongest ones clearly.
- If this is a pre-purchase case, protect the user financially.
- If the case could be unsafe to drive, say so calmly and directly.
- Do not answer like a code dictionary unless the user clearly asked for code meaning only.
`.trim();
}

function buildOpenAIMessages({
  systemPrompt,
  history = [],
  contextBlock,
  image,
}) {
  let messages = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  if (Array.isArray(history) && history.length > 0) {
    const sanitized = history
      .filter((item) => item?.role === "user" || item?.role === "assistant")
      .slice(-10)
      .map((item) => ({
        role: item.role,
        content:
          typeof item.content === "string"
            ? item.content
            : JSON.stringify(item.content || ""),
      }));

    messages = messages.concat(sanitized);
  }

  if (image) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: contextBlock,
        },
        {
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${image}`,
          },
        },
      ],
    });
  } else {
    messages.push({
      role: "user",
      content: contextBlock,
    });
  }

  return messages;
}

function buildLocationPrompt({
  language = "same-as-user",
  dialect = "natural-user-style",
  primaryIntent = "places",
  routedIntent = {},
}) {
  const key = `${String(language).toLowerCase()}|${String(dialect).toLowerCase()}|${String(primaryIntent).toLowerCase()}`;

  if (/[اأإآء-ي]/.test(key) || key.includes("arab")) {
    if (routedIntent?.localSearchType === "towing") {
      return "أرسل لي موقعك أو اسم المدينة أو الرمز البريدي حتى أقدر أبحث لك عن سطحة أو خدمة سحب قريبة مناسبة.";
    }

    return "أرسل لي موقعك أو اسم المدينة أو الرمز البريدي حتى أقدر أبحث لك عن أقرب ورشة أو محل مناسب للحالة.";
  }

  return "Send me your GPS location, city, or ZIP code so I can find the right nearby shop for this case.";
}
