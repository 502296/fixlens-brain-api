// service.js — FixLens Brain v12
// Data-first diagnostic orchestrator
// English-first brain, English/Spanish output priority
// Added structured visual diagnostic payload for UI cards

import OpenAI from "openai";

import { buildDoctorSystemPrompt } from "./doctorPrompt.js";
import { buildDiagnosticMemory } from "./memoryEngine.js";
import { buildResponsePlan } from "./responsePlanner.js";
import { buildEnginePack } from "./engineIntel.js";
import { detectIntent } from "./intentDetector.js";
import { resolveIntent } from "./intentRouter.js";

import { processAudio } from "./audioProcessor.js";
import { performSearch } from "./search.js";
import { runDiagnosticEngine } from "./diagnosticEngine.js";

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
        console.log("[AUDIO DEBUG]", {
          bodyKeys: Object.keys(body || {}),
          hasAudioField: Boolean(audio),
          audioType: typeof audio,
          audioLength: typeof audio === "string" ? audio.length : null,
          audioKind: body.audio_kind || body.audio_type || null,
          audioMime: body.audio_mime || null,
          audioFilename: body.audio_filename || null,
        });

        const audioResult = await processAudio({
          audio_base64: audio,
          locale,
          audio_kind: body.audio_kind || body.audio_type || "unknown",
          audio_mime: body.audio_mime || "",
          audio_filename: body.audio_filename || "",
        });

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
          } else if (!normalizeTextLoose(userText).includes(normalizeTextLoose(audioTranscript))) {
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
        language: "english",
        dialect: "us",
        searched: false,
        diagnostic_card: null,
        symptom_signals: [],
        action_steps: [],
        warning_flag: null,
        visual_labels: buildVisualLabels("english"),
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
       English + Spanish focused
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
      normalizeSupportedLanguage(
        modelIntent.userLanguage ||
        detectPreferredLanguageFromText(userText) ||
        "english"
      );

    const detectedDialect =
      normalizeSupportedDialect(
        modelIntent.userDialect ||
        (detectedLanguage === "spanish" ? "latin-american-spanish" : "us-english")
      );

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
       DIAGNOSTIC ENGINE v1
       Data-first decision layer
    ------------------------- */
    let diagnosticEngine = {
      scope: "engine",
      normalizedText: "",
      engineHints: [],
      matchedSignals: [],
      topIssue: null,
      topEngine: null,
      confidence: 0.18,
      riskLevel: "low",
      matchedKeywords: [],
      firstChecks: [],
      mechanism: "",
      symptomNotes: [],
      commonMisreads: [],
      doNotConfuseWith: [],
      rankedFindings: [],
    };

    try {
      const memoryVehicle = memory?.current_case_summary?.vehicle || {};
      const enrichedForDiagnostic = enrichTextWithVehicle(userText, {
        year: enginePack?.year || memoryVehicle?.year || null,
        make: enginePack?.make || memoryVehicle?.make || null,
        model: enginePack?.model || memoryVehicle?.model || null,
        engine: enginePack?.detected_engine || memoryVehicle?.engine || null,
      });

      diagnosticEngine = runDiagnosticEngine({
        userText: enrichedForDiagnostic,
      });
    } catch (error) {
      console.log("Diagnostic engine failed:", error?.message || error);
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
        diagnosticEngine,
        diagnosticMemory: memory,
        verifiedData,
        verifiedWorkshops,
        internalIntelStrong:
          Number(enginePack?.intel_score || 0) >= 8 ||
          Number((diagnosticEngine?.confidence || 0) * 10) >= 7,
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
        diagnostic_card: null,
        symptom_signals: [],
        action_steps: [],
        warning_flag: null,
        visual_labels: buildVisualLabels(detectedLanguage),
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
      diagnosticEngine,
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
      temperature: 0.2,
      messages,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "I could not produce a reliable diagnostic answer.";

    const uiPayload = buildVisualDiagnosticPayload({
      language: detectedLanguage,
      diagnosticEngine,
      responsePlan,
      enginePack,
      verifiedActions,
      verifiedWorkshops,
      reply,
      primaryIntent,
    });

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
      diagnostic_card: uiPayload.diagnostic_card,
      symptom_signals: uiPayload.symptom_signals,
      action_steps: uiPayload.action_steps,
      warning_flag: uiPayload.warning_flag,
      visual_labels: uiPayload.visual_labels,
      debug: body?.debug
        ? {
            route_mode: routedIntent.mode,
            diagnosis_mode: ruleIntent?.diagnosisMode || null,
            engine_identity: enginePack?.vehicle_identity || null,
            strongest_hypothesis: responsePlan?.strongest_hypothesis || null,
            diagnostic_top_issue: diagnosticEngine?.topIssue || null,
            diagnostic_top_engine: diagnosticEngine?.topEngine || null,
            diagnostic_confidence: diagnosticEngine?.confidence || null,
            diagnostic_risk: diagnosticEngine?.riskLevel || null,
            diagnostic_signals: diagnosticEngine?.matchedSignals || [],
            diagnostic_keywords: diagnosticEngine?.matchedKeywords || [],
            local_search_type: routedIntent?.localSearchType || null,
            codes: responsePlan?.codes || [],
            matched_action_ids: verifiedActions.map((x) => x?.id).filter(Boolean),
            ui_payload: uiPayload,
          }
        : undefined,
    };
  } catch (error) {
    console.error("FixLens service error:", error);

    return {
      ok: false,
      reply: "FixLens hit an internal error while analyzing this case.",
      intent: "error",
      language: "english",
      dialect: "us-english",
      diagnostic_card: null,
      symptom_signals: [],
      action_steps: [],
      warning_flag: null,
      visual_labels: buildVisualLabels("english"),
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
The product currently supports English and Spanish output only.
If the user writes in another language, choose whichever of English or Spanish is closer, but prefer English by default.

Return JSON only.

Required keys:
- primaryIntent: one of "diagnosis", "places", "hybrid", "general"
- needsSearch: boolean
- askForLocation: boolean
- userLanguage: must be "english" or "spanish"
- userDialect: short label such as "us-english", "latin-american-spanish", "neutral-spanish"

Rules:
- "diagnosis" = diagnosis, fault analysis, next checks, code analysis, image/dashboard reading, audio/noise interpretation, safety judgment, or pre-purchase technical judgment
- "places" = nearby shops, addresses, maps, towing, parts stores, or local help
- "hybrid" = both diagnosis and local help
- "general" = greeting or unclear request

needsSearch:
- true when nearby help, workshop lookup, parts store lookup, towing, or local action is needed
- false for pure diagnosis unless local help is clearly requested

askForLocation:
- true only when local help is needed but there is no usable city / zip / GPS / location in the request or provided location field
- false otherwise
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
      return fallbackIntent(ruleIntent, routedIntent, text);
    }

    return {
      primaryIntent: normalizePrimaryIntent(parsed.primaryIntent, routedIntent),
      needsSearch: Boolean(parsed.needsSearch),
      askForLocation: Boolean(parsed.askForLocation),
      userLanguage: normalizeSupportedLanguage(parsed.userLanguage || detectPreferredLanguageFromText(text)),
      userDialect: normalizeSupportedDialect(parsed.userDialect),
    };
  } catch (error) {
    console.log("Model intent bridge failed:", error?.message || error);
    return fallbackIntent(ruleIntent, routedIntent, text);
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

function normalizeTextLoose(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\s.,-]/gu, " ")
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

function normalizeSupportedLanguage(value = "") {
  const v = String(value || "").toLowerCase().trim();

  if (
    v.includes("spanish") ||
    v.includes("españ") ||
    v === "es" ||
    v === "spa"
  ) {
    return "spanish";
  }

  return "english";
}

function normalizeSupportedDialect(value = "") {
  const v = String(value || "").toLowerCase().trim();

  if (!v) return "us-english";

  if (v.includes("spanish") || v.includes("lat") || v.includes("mex") || v.includes("neutral")) {
    return "latin-american-spanish";
  }

  return "us-english";
}

function detectPreferredLanguageFromText(text = "") {
  const t = String(text || "");

  if (/[áéíóúñü¿¡]/i.test(t)) return "spanish";

  const spanishHints = [
    "carro",
    "coche",
    "mecánico",
    "mecanico",
    "ruido",
    "motor",
    "vibra",
    "tiembla",
    "enciende",
    "taller",
    "dirección",
    "direccion",
    "por favor",
  ];

  const lower = t.toLowerCase();
  if (spanishHints.some((w) => lower.includes(w))) {
    return "spanish";
  }

  return "english";
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

function fallbackIntent(ruleIntent = {}, routedIntent = {}, text = "") {
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
    userLanguage: normalizeSupportedLanguage(detectPreferredLanguageFromText(text)),
    userDialect:
      normalizeSupportedLanguage(detectPreferredLanguageFromText(text)) === "spanish"
        ? "latin-american-spanish"
        : "us-english",
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

function formatDiagnosticEngineForContext(diagnosticEngine = {}) {
  return {
    top_issue: diagnosticEngine?.topIssue || null,
    top_engine: diagnosticEngine?.topEngine || null,
    confidence: diagnosticEngine?.confidence ?? null,
    risk_level: diagnosticEngine?.riskLevel || null,
    detected_codes: diagnosticEngine?.detectedCodes || [],
    matched_signals: diagnosticEngine?.matchedSignals || [],
    matched_keywords: diagnosticEngine?.matchedKeywords || [],
    first_checks: diagnosticEngine?.firstChecks || [],
    mechanism: diagnosticEngine?.mechanism || "",
    symptom_notes: diagnosticEngine?.symptomNotes || [],
    common_misreads: diagnosticEngine?.commonMisreads || [],
    do_not_confuse_with: diagnosticEngine?.doNotConfuseWith || [],
    caution_flags: diagnosticEngine?.cautionFlags || [],
    ranked_findings: diagnosticEngine?.rankedFindings || [],
  };
}

/* =========================================================
   VISUAL PAYLOAD HELPERS
========================================================= */
function buildVisualDiagnosticPayload({
  language = "english",
  diagnosticEngine = {},
  responsePlan = {},
  enginePack = {},
  verifiedActions = [],
  verifiedWorkshops = [],
  reply = "",
  primaryIntent = "diagnosis",
}) {
  const visualLabels = buildVisualLabels(language);

  if (primaryIntent === "places" && !diagnosticEngine?.topIssue) {
    return {
      diagnostic_card: null,
      symptom_signals: [],
      action_steps: [],
      warning_flag: null,
      visual_labels: visualLabels,
    };
  }

  const issueTitle = pickLikelyIssue({
    diagnosticEngine,
    responsePlan,
    enginePack,
    language,
  });

  const confidenceValue = clamp01(
    Number(diagnosticEngine?.confidence ?? 0)
  );

  const confidenceLabel = formatConfidenceLabel(confidenceValue, language);
  const riskLevel = normalizeRiskLevel(
    diagnosticEngine?.riskLevel || responsePlan?.severity || "medium"
  );

  const severityLabel = formatSeverityLabel(riskLevel, language);
  const summary = buildDiagnosticSummary({
    language,
    issueTitle,
    diagnosticEngine,
    responsePlan,
  });

  const symptomSignals = buildSymptomSignals({
    language,
    diagnosticEngine,
    responsePlan,
  });

  const actionSteps = buildActionSteps({
    language,
    diagnosticEngine,
    responsePlan,
    verifiedActions,
    verifiedWorkshops,
  });

  const warningFlag = buildWarningFlag({
    language,
    riskLevel,
    diagnosticEngine,
    responsePlan,
    reply,
  });

  const diagnosticCard =
    issueTitle
      ? {
          title: issueTitle,
          severity: riskLevel,
          severity_label: severityLabel,
          confidence: confidenceValue,
          confidence_label: confidenceLabel,
          summary,
          vehicle_identity: enginePack?.vehicle_identity || null,
          top_engine: diagnosticEngine?.topEngine || null,
          ui_variant: mapRiskToVariant(riskLevel),
        }
      : null;

  return {
    diagnostic_card: diagnosticCard,
    symptom_signals: symptomSignals,
    action_steps: actionSteps,
    warning_flag: warningFlag,
    visual_labels: visualLabels,
  };
}

function buildVisualLabels(language = "english") {
  if (normalizeSupportedLanguage(language) === "spanish") {
    return {
      likely_issue: "Posible problema",
      what_fixlens_sees: "Lo que FixLens detecta",
      recommended_actions: "Acciones recomendadas",
      caution: "Precaución",
    };
  }

  return {
    likely_issue: "Likely Issue",
    what_fixlens_sees: "What FixLens Sees",
    recommended_actions: "Recommended Actions",
    caution: "Caution",
  };
}

function pickLikelyIssue({
  diagnosticEngine = {},
  responsePlan = {},
  enginePack = {},
  language = "english",
}) {
  const candidates = [
    diagnosticEngine?.topIssue,
    responsePlan?.strongest_hypothesis,
    firstNonEmptyString(responsePlan?.likely_causes),
    firstRankedFindingTitle(diagnosticEngine?.rankedFindings),
  ].filter((x) => typeof x === "string" && x.trim());

  let issue = candidates[0] || "";

  issue = cleanIssueTitle(issue);

  if (!issue) {
    const vehicle = enginePack?.vehicle_identity
      ? `${enginePack.vehicle_identity} `
      : "";

    if (normalizeSupportedLanguage(language) === "spanish") {
      return `${vehicle}ruta probable de falla mecánica`.trim();
    }
    return `${vehicle}probable mechanical fault path`.trim();
  }

  return issue;
}

function cleanIssueTitle(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\-\–\—•\d.\)\s]+/, "")
    .trim();
}

function buildDiagnosticSummary({
  language = "english",
  issueTitle = "",
  diagnosticEngine = {},
  responsePlan = {},
}) {
  const lang = normalizeSupportedLanguage(language);
  const matchedSignals = Array.isArray(diagnosticEngine?.matchedSignals)
    ? diagnosticEngine.matchedSignals.filter(Boolean)
    : [];

  const safetyAdvice = String(responsePlan?.safety_advice || "").trim();

  if (lang === "spanish") {
    if (matchedSignals.length > 0) {
      return `FixLens detectó señales compatibles con ${issueTitle.toLowerCase()}.`;
    }
    if (safetyAdvice) {
      return "FixLens detectó una ruta de falla que requiere verificación mecánica.";
    }
    return "FixLens detectó un patrón que merece una revisión específica.";
  }

  if (matchedSignals.length > 0) {
    return `FixLens detected signals consistent with ${issueTitle.toLowerCase()}.`;
  }
  if (safetyAdvice) {
    return "FixLens detected a fault path that deserves mechanical verification.";
  }
  return "FixLens detected a pattern that deserves targeted inspection.";
}

function buildSymptomSignals({
  language = "english",
  diagnosticEngine = {},
  responsePlan = {},
}) {
  const lang = normalizeSupportedLanguage(language);

  const rawSignals = [
    ...(Array.isArray(diagnosticEngine?.matchedSignals) ? diagnosticEngine.matchedSignals : []),
    ...(Array.isArray(diagnosticEngine?.symptomNotes) ? diagnosticEngine.symptomNotes : []),
    ...(Array.isArray(responsePlan?.evidence_summary) ? responsePlan.evidence_summary : []),
  ]
    .map((x) => cleanBulletText(x))
    .filter(Boolean);

  const uniqueSignals = uniqueStrings(rawSignals).slice(0, 4);

  return uniqueSignals.map((text) => ({
    text,
    icon: inferSignalIcon(text),
    tone: inferSignalTone(text),
    language: lang,
  }));
}

function buildActionSteps({
  language = "english",
  diagnosticEngine = {},
  responsePlan = {},
  verifiedActions = [],
  verifiedWorkshops = [],
}) {
  const lang = normalizeSupportedLanguage(language);

  const actionPool = [
    ...(Array.isArray(diagnosticEngine?.firstChecks) ? diagnosticEngine.firstChecks : []),
    ...(Array.isArray(responsePlan?.tests) ? responsePlan.tests : []),
    ...flattenVerifiedActionSteps(verifiedActions),
  ]
    .map((x) => cleanBulletText(x))
    .filter(Boolean);

  let steps = uniqueStrings(actionPool).slice(0, 4);

  if (steps.length === 0 && verifiedWorkshops.length > 0) {
    if (lang === "spanish") {
      steps = ["Buscar un taller confiable cercano para una inspección confirmatoria."];
    } else {
      steps = ["Find a trusted nearby shop for a confirmatory inspection."];
    }
  }

  return steps.map((text, index) => ({
    step: index + 1,
    text,
    done: false,
  }));
}

function buildWarningFlag({
  language = "english",
  riskLevel = "medium",
  diagnosticEngine = {},
  responsePlan = {},
  reply = "",
}) {
  const lang = normalizeSupportedLanguage(language);
  const replyText = String(reply || "").toLowerCase();
  const safetyAdvice = String(responsePlan?.safety_advice || "").trim();
  const cautionFlags = Array.isArray(diagnosticEngine?.cautionFlags)
    ? diagnosticEngine.cautionFlags.filter(Boolean)
    : [];

  const mustWarn =
    riskLevel === "high" ||
    /do not drive|don't drive|avoid driving|stop driving|unsafe to drive|tow/i.test(replyText) ||
    /no conduzcas|evita conducir|no lo conduzcas|grúa|remolque/i.test(replyText) ||
    cautionFlags.length > 0 ||
    Boolean(safetyAdvice);

  if (!mustWarn) return null;

  let message = "";

  if (safetyAdvice) {
    message = cleanBulletText(safetyAdvice);
  } else if (cautionFlags.length > 0) {
    message = cleanBulletText(cautionFlags[0]);
  } else if (lang === "spanish") {
    message =
      riskLevel === "high"
        ? "Evita conducirlo hasta revisar esta falla."
        : "Conduce con cuidado y revisa esta falla pronto.";
  } else {
    message =
      riskLevel === "high"
        ? "Avoid driving it until this fault is checked."
        : "Drive carefully and have this fault checked soon.";
  }

  return {
    show: true,
    level: riskLevel,
    message,
    ui_variant: mapRiskToVariant(riskLevel),
  };
}

function normalizeRiskLevel(value = "") {
  const v = String(value || "").toLowerCase().trim();

  if (["high", "severe", "critical", "urgent", "danger"].includes(v)) return "high";
  if (["low", "minor", "light"].includes(v)) return "low";
  return "medium";
}

function mapRiskToVariant(riskLevel = "medium") {
  if (riskLevel === "high") return "danger";
  if (riskLevel === "low") return "calm";
  return "warning";
}

function formatSeverityLabel(riskLevel = "medium", language = "english") {
  const lang = normalizeSupportedLanguage(language);

  if (lang === "spanish") {
    if (riskLevel === "high") return "Riesgo alto";
    if (riskLevel === "low") return "Riesgo bajo";
    return "Riesgo medio";
  }

  if (riskLevel === "high") return "High Risk";
  if (riskLevel === "low") return "Low Risk";
  return "Medium Risk";
}

function formatConfidenceLabel(value = 0, language = "english") {
  const lang = normalizeSupportedLanguage(language);

  if (lang === "spanish") {
    if (value >= 0.8) return "Confianza alta";
    if (value >= 0.55) return "Confianza moderada";
    return "Confianza inicial";
  }

  if (value >= 0.8) return "High Confidence";
  if (value >= 0.55) return "Moderate Confidence";
  return "Early Confidence";
}

function firstRankedFindingTitle(rankedFindings = []) {
  if (!Array.isArray(rankedFindings) || rankedFindings.length === 0) return "";
  const first = rankedFindings[0];
  if (typeof first === "string") return first;
  if (typeof first?.title === "string") return first.title;
  if (typeof first?.issue === "string") return first.issue;
  if (typeof first?.name === "string") return first.name;
  return "";
}

function firstNonEmptyString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const found = value.find((x) => typeof x === "string" && x.trim());
    return found ? found.trim() : "";
  }
  return "";
}

function flattenVerifiedActionSteps(items = []) {
  const out = [];

  for (const item of Array.isArray(items) ? items : []) {
    if (Array.isArray(item?.actions)) {
      for (const action of item.actions) {
        if (typeof action === "string") out.push(action);
        else if (typeof action?.text === "string") out.push(action.text);
        else if (typeof action?.label === "string") out.push(action.label);
      }
    }
  }

  return out;
}

function uniqueStrings(items = []) {
  const seen = new Set();
  const out = [];

  for (const item of items) {
    const normalized = normalizeTextLoose(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(String(item).trim());
  }

  return out;
}

function cleanBulletText(value = "") {
  return String(value || "")
    .replace(/^[•\-\–\—*\d.\)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function inferSignalIcon(text = "") {
  const t = String(text || "").toLowerCase();

  if (/temperat|heat|overheat|coolant|hot/.test(t)) return "temperature";
  if (/fan|blower/.test(t)) return "fan";
  if (/misfire|shake|rough|vibration|vibrate/.test(t)) return "vibration";
  if (/oil|pressure/.test(t)) return "oil";
  if (/battery|voltage|charging|alternator/.test(t)) return "battery";
  if (/brake|stopping/.test(t)) return "brake";
  if (/smoke|burn/.test(t)) return "warning";
  return "signal";
}

function inferSignalTone(text = "") {
  const t = String(text || "").toLowerCase();

  if (/overheat|smoke|burn|danger|critical|no start/.test(t)) return "high";
  if (/intermittent|sometimes|minor|light/.test(t)) return "low";
  return "medium";
}

function clamp01(value = 0) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
  diagnosticEngine,
  responsePlan,
  verifiedData,
  verifiedActions,
  verifiedWorkshops,
  searchMeta,
}) {
  return `
FIXLENS_CASE_CONTEXT:
LOCALE=${JSON.stringify(locale || "auto")}
DETECTED_USER_LANGUAGE=${JSON.stringify(detectedLanguage || "english")}
DETECTED_USER_DIALECT=${JSON.stringify(detectedDialect || "us-english")}
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

DIAGNOSTIC_ENGINE:
${JSON.stringify(formatDiagnosticEngineForContext(diagnosticEngine), null, 2)}

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
- The product currently supports output in English or Spanish only.
- Reply in English or Spanish depending on the detected user language. Default to English if unclear.
- Keep language locked unless the user clearly switches.
- Think as one senior mechanic, not as separate modules.
- DIAGNOSTIC_ENGINE is the primary diagnosis layer. Treat it as the strongest internal evidence when confidence is solid.
- If DIAGNOSTIC_ENGINE.top_issue is present with confidence >= 0.64, lead with that diagnosis unless stronger verified evidence contradicts it.
- Use DIAGNOSTIC_ENGINE.first_checks before inventing generic steps.
- Use DIAGNOSTIC_ENGINE.common_misreads and do_not_confuse_with to avoid wrong fault paths.
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
- Do not over-explain. Be sharp, confident, and mechanically specific.
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
  language = "english",
  dialect = "us-english",
  primaryIntent = "places",
  routedIntent = {},
}) {
  const lang = normalizeSupportedLanguage(language);

  if (lang === "spanish") {
    if (routedIntent?.localSearchType === "towing") {
      return "Envíame tu ubicación, ciudad o código postal para buscar una grúa o servicio de remolque cercano.";
    }

    return "Envíame tu ubicación, ciudad o código postal para buscar un taller o mecánico cercano para este caso.";
  }

  if (routedIntent?.localSearchType === "towing") {
    return "Send me your GPS location, city, or ZIP code so I can find a nearby towing service.";
  }

  return "Send me your GPS location, city, or ZIP code so I can find the right nearby shop for this case.";
}
