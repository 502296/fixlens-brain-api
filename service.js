// service.js — FixLens Brain v15
// Doctor Brain orchestrator — calm, data-first, search/GPS-aware, premium user-facing responses

import OpenAI from "openai";

import { DOCTOR_PROMPT } from "./doctorPrompt.js";
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

const MODEL = process.env.FIXLENS_MODEL || "gpt-4o";

export async function handleFixLensRequest(req) {
  try {
    const body = req?.body || {};

    const rawText = extractUserText(body);
    const history = normalizeHistory(body);
    const image = extractImage(body);
    const audio = extractAudio(body);
    const locale = String(body.locale || body.lang || body.language || "auto").trim();

    const location =
      body.user_location ||
      body.location ||
      body.gps ||
      body.latlng ||
      body.coordinates ||
      body.city ||
      body.zip ||
      null;

    let userText = rawText;
    let audioTranscript = "";

    if (audio) {
      try {
        const audioResult = await processAudio({
          audio_base64: audio,
          locale,
          audio_kind: body.audio_kind || body.audio_type || "unknown",
          audio_mime: body.audio_mime || "",
          audio_filename: body.audio_filename || "",
        });

        audioTranscript =
          typeof audioResult === "string"
            ? audioResult.trim()
            : String(audioResult?.text || "").trim();

        if (audioTranscript) {
          userText = hasMeaningfulText(userText)
            ? `${userText}\n\n[Audio transcript]\n${audioTranscript}`
            : audioTranscript;
        }
      } catch (error) {
        console.log("Audio processing failed:", error?.message || error);
      }
    }

    if (!hasMeaningfulText(userText) && !image) {
      return baseResponse({
        reply:
          "Please describe what the vehicle is doing, when it happens, and what car or truck you have.",
        intent: "general",
      });
    }

    const ruleIntent = safeCall(
      () => detectIntent({ text: userText, history, location }),
      defaultRuleIntent({ image, audio })
    );

    const routedIntent = safeCall(
      () =>
        resolveIntent({
          text: userText,
          history,
          hasImage: Boolean(image),
          hasAudio: Boolean(audio),
        }),
      defaultRoutedIntent({ location, image, audio })
    );

    const modelIntent = await classifyIntentCheap({
      text: userText,
      location,
      ruleIntent,
      routedIntent,
    });

    const primaryIntent =
      modelIntent.primaryIntent ||
      ruleIntent.primaryIntent ||
      (routedIntent.isPlaces ? "places" : "diagnosis");

    const language = normalizeSupportedLanguage(
      modelIntent.userLanguage || detectPreferredLanguageFromText(userText)
    );

    const dialect =
      language === "spanish" ? "latin-american-spanish" : "us-english";

    const wantsPlaces =
      primaryIntent === "places" ||
      primaryIntent === "hybrid" ||
      Boolean(ruleIntent.places) ||
      Boolean(routedIntent.isPlaces);

    const needsLocation =
      wantsPlaces && !hasUsableLocation(location, userText);

    if (needsLocation) {
      return baseResponse({
        reply: buildLocationPrompt({ language, routedIntent }),
        intent: primaryIntent,
        language,
        dialect,
        needs_location: true,
      });
    }

    const memory = safeCall(
      () =>
        buildDiagnosticMemory({
          text: userText,
          history,
          voiceText: audioTranscript,
          audioType: audio ? "speech_or_vehicle_audio" : "none",
        }),
      {
        current_case_summary: {},
        memory_text: "none",
      }
    );

    const memoryVehicle = memory?.current_case_summary?.vehicle || {};
    const enrichedText = enrichTextWithVehicle(userText, memoryVehicle);

    const enginePack = safeCall(() => buildEnginePack(enrichedText), {
      make: null,
      model: null,
      year: null,
      detected_engine: null,
      vehicle_identity: null,
      intel_score: 0,
    });

    const diagnosticText = enrichTextWithVehicle(userText, {
      year: enginePack?.year || memoryVehicle?.year || null,
      make: enginePack?.make || memoryVehicle?.make || null,
      model: enginePack?.model || memoryVehicle?.model || null,
      engine: enginePack?.detected_engine || memoryVehicle?.engine || null,
    });

    const diagnosticEngine = safeCall(
      () => runDiagnosticEngine({ userText: diagnosticText }),
      defaultDiagnosticEngine()
    );

    let search = {
      verified_data: [],
      verified_actions: [],
      verified_workshops: [],
      search_meta: {},
    };

    if (wantsPlaces) {
      search = await safeAsyncCall(
        () =>
          performSearch(userText, location, {
            locale,
            allowPlaces: true,
            forcePlaces: true,
            maxResults: 4,
          }),
        search
      );
    } else {
      search = await safeAsyncCall(
        () =>
          performSearch(userText, null, {
            locale,
            allowPlaces: false,
            forcePlaces: false,
            maxResults: 3,
          }),
        search
      );
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

    const responsePlan = safeCall(
      () =>
        buildResponsePlan({
          locale,
          text: userText,
          placesIntent: wantsPlaces,
          enginePack,
          diagnosticEngine,
          diagnosticMemory: memory,
          verifiedData,
          verifiedWorkshops,
          internalIntelStrong:
            Number(enginePack?.intel_score || 0) >= 8 ||
            Number((diagnosticEngine?.confidence || 0) * 10) >= 7,
        }),
      {
        severity: "medium",
        strongest_hypothesis: "mechanical fault path needs confirmation",
        tests: [],
        evidence_summary: [],
        safety_advice: "",
        planner_text: "none",
      }
    );

    const aiReply = await buildAIReply({
      history,
      image,
      locale,
      language,
      dialect,
      primaryIntent,
      userText,
      audioTranscript,
      memory,
      enginePack,
      diagnosticEngine,
      responsePlan,
      verifiedData,
      verifiedActions,
      verifiedWorkshops,
      wantsPlaces,
      location,
    });

    const reply = buildDoctorFinalResponse({
      aiReply,
      language,
      diagnosticEngine,
      responsePlan,
      enginePack,
      wantsPlaces,
      verifiedWorkshops,
    });

    const uiPayload = buildVisualDiagnosticPayload({
      language,
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
      language,
      dialect,
      searched:
        verifiedData.length > 0 ||
        verifiedActions.length > 0 ||
        verifiedWorkshops.length > 0,
      diagnostic_card: uiPayload.diagnostic_card,
      symptom_signals: uiPayload.symptom_signals,
      action_steps: uiPayload.action_steps,
      warning_flag: uiPayload.warning_flag,
      visual_labels: buildVisualLabels(language),
      debug: body?.debug
        ? {
            route_mode: routedIntent?.mode || null,
            diagnostic_top_issue: diagnosticEngine?.topIssue || null,
            diagnostic_confidence: diagnosticEngine?.confidence || null,
            diagnostic_risk: diagnosticEngine?.riskLevel || null,
            used_ai: Boolean(aiReply),
          }
        : undefined,
    };
  } catch (error) {
    console.error("FixLens service error:", error);
    return baseResponse({
      ok: false,
      reply: "FixLens hit an internal error while analyzing this case.",
      intent: "error",
    });
  }
}

/* =========================================================
   AI DOCTOR BRAIN
========================================================= */

async function buildAIReply({
  history = [],
  image,
  locale,
  language,
  dialect,
  primaryIntent,
  userText,
  audioTranscript,
  memory,
  enginePack,
  diagnosticEngine,
  responsePlan,
  verifiedData,
  verifiedActions,
  verifiedWorkshops,
  wantsPlaces = false,
  location = null,
}) {
  try {
    const outputLanguage = language === "spanish" ? "Spanish" : "English";

    const systemPrompt = `${DOCTOR_PROMPT}

FixLens execution rules for this exact response:
- Output only in ${outputLanguage}.
- Use the response plan, search results, GPS context, and diagnostic engine as internal guidance only.
- Never expose internal tokens or metadata.
- Never mention confidence percentages.
- Never write "Most likely cause".
- Never expose words like check_engine, riskLevel, confidence, cluster, planner, engine score, or metadata.
- Do not suggest nearby shops, GPS, maps, location, or Yelp unless the user clearly asked for nearby help.
- If the user asks for nearby help and verified workshops exist, include a short "Nearby options" section.
- Keep the tone calm, premium, practical, and human.
- Do not scare the driver.
- Do not over-ask questions.
- Ask only one follow-up question if it truly changes the next step.
- Use this structure unless the user asked for something else:

Diagnosis:
[1 calm sentence based on the symptoms. No absolute conclusion.]

Possible causes:
- [2 to 4 causes, simple/common first]

What to check first:
1. [2 to 4 practical checks]

Driving condition:
[calm safety note]

Next question:
[Only one question if needed.]`;

    const contextBlock = `
FIXLENS_INTERNAL_CONTEXT:
locale=${locale}
language=${language}
dialect=${dialect}
intent=${primaryIntent}
user_asked_nearby_help=${Boolean(wantsPlaces)}
location_available=${Boolean(location)}

USER_TEXT:
${userText || ""}

AUDIO_TRANSCRIPT:
${audioTranscript || "none"}

MEMORY:
${memory?.memory_text || "none"}

ENGINE_PACK:
${JSON.stringify(enginePack || {}, null, 2)}

DIAGNOSTIC_ENGINE_INTERNAL:
${JSON.stringify(formatDiagnosticEngineForContext(diagnosticEngine), null, 2)}

RESPONSE_PLAN:
${responsePlan?.planner_text || JSON.stringify(responsePlan || {}, null, 2)}

VERIFIED_DATA:
${JSON.stringify(formatSearchDataForContext(verifiedData, 3), null, 2)}

VERIFIED_ACTIONS:
${JSON.stringify(formatVerifiedActionsForContext(verifiedActions, 3), null, 2)}

VERIFIED_WORKSHOPS:
${JSON.stringify(formatSearchDataForContext(verifiedWorkshops, 4), null, 2)}

FINAL_OUTPUT_FILTER:
Before answering, silently remove:
- confidence percentages
- internal labels/tokens
- "Most likely cause"
- scary wording
- unnecessary location/shop suggestions
`.trim();

    const messages = buildOpenAIMessages({
      systemPrompt,
      history,
      contextBlock,
      image,
    });

    const completion = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.18,
      messages,
    });

    return completion?.choices?.[0]?.message?.content?.trim() || "";
  } catch (error) {
    console.log("AI doctor reply failed:", error?.message || error);
    return "";
  }
}

/* =========================================================
   DOCTOR RESPONSE FINALIZER
========================================================= */

function buildDoctorFinalResponse({
  aiReply = "",
  language = "english",
  diagnosticEngine = {},
  responsePlan = {},
  enginePack = {},
  wantsPlaces = false,
  verifiedWorkshops = [],
}) {
  const lang = normalizeSupportedLanguage(language);

  if (aiReply && aiReply.trim().length > 20) {
    return sanitizeUserFacingReply(trimLongReply(aiReply), {
      language: lang,
      wantsPlaces,
    });
  }

  const issue = cleanIssueTitle(
    responsePlan?.strongest_hypothesis ||
      diagnosticEngine?.topIssue ||
      firstRankedFindingTitle(diagnosticEngine?.rankedFindings) ||
      "a mechanical issue that needs confirmation"
  );

  const causes = uniqueStrings([
    ...(Array.isArray(responsePlan?.likely_causes) ? responsePlan.likely_causes : []),
    issue,
  ])
    .map(cleanIssueTitle)
    .filter(Boolean)
    .slice(0, 4);

  const checks = uniqueStrings([
    ...(Array.isArray(responsePlan?.tests) ? responsePlan.tests : []),
    ...(Array.isArray(diagnosticEngine?.firstChecks) ? diagnosticEngine.firstChecks : []),
  ])
    .map(cleanBulletText)
    .filter(Boolean)
    .slice(0, 4);

  const drivingCondition =
    responsePlan?.safety_advice ||
    "Short, gentle driving may be okay, but it should be checked soon if the symptom continues or gets worse.";

  if (lang === "spanish") {
    return sanitizeUserFacingReply(
      `
Diagnosis:
Según lo que describes, esto parece relacionado con ${issue.toLowerCase()}.

Possible causes:
${formatBullets(causes, ["Bujías desgastadas", "Bobina de encendido débil", "Pequeña fuga de vacío"])}

What to check first:
${formatNumbered(checks, ["Escanear códigos de falla si es posible", "Revisar bujías y bobinas", "Revisar mangueras de admisión por fuga de vacío"])}

Driving condition:
${drivingCondition}
`.trim(),
      { language: lang, wantsPlaces }
    );
  }

  if (wantsPlaces && verifiedWorkshops.length > 0) {
    const shops = verifiedWorkshops
      .slice(0, 3)
      .map((x, i) => {
        const name = x?.name || x?.title || "Nearby shop";
        const rating = x?.rating ? ` — ${x.rating}★` : "";
        const address = x?.address ? ` — ${x.address}` : "";
        const phone = x?.phone ? ` — ${x.phone}` : "";
        return `${i + 1}. ${name}${rating}${address}${phone}`;
      })
      .join("\n");

    return sanitizeUserFacingReply(
      `
Diagnosis:
Based on what you described, this looks related to ${issue.toLowerCase()}.

Possible causes:
${formatBullets(causes, ["Worn spark plugs", "Weak ignition coil", "Small vacuum leak"])}

What to check first:
${formatNumbered(checks, ["Scan for fault codes if available", "Inspect spark plugs and ignition coils", "Check intake hoses for a vacuum leak"])}

Nearby options:
${shops}

Driving condition:
${drivingCondition}
`.trim(),
      { language: lang, wantsPlaces }
    );
  }

  return sanitizeUserFacingReply(
    `
Diagnosis:
Based on what you described, this looks related to ${issue.toLowerCase()}.

Possible causes:
${formatBullets(causes, ["Worn spark plugs", "Weak ignition coil", "Small vacuum leak"])}

What to check first:
${formatNumbered(checks, ["Scan for fault codes if available", "Inspect spark plugs and ignition coils", "Check intake hoses for a vacuum leak"])}

Driving condition:
${drivingCondition}
`.trim(),
    { language: lang, wantsPlaces }
  );
}

function sanitizeUserFacingReply(reply = "", { language = "english", wantsPlaces = false } = {}) {
  let text = String(reply || "").trim();

  text = text
    .replace(/\bMost likely cause\s*:\s*/gi, "")
    .replace(/^Optional:\s*/gim, "")
    .replace(/^If needed:\s*/gim, "")
    .replace(/^Next question:\s*$/gim, "")
    .replace(/\(\s*\d{1,3}%\s*confidence\s*\)/gi, "")
    .replace(/\b\d{1,3}%\s*confidence\b/gi, "")
    .replace(/\bconfidence\s*[:=]\s*\d+(\.\d+)?\b/gi, "")
    .replace(/\bcheck_engine\b/gi, "check-engine light")
    .replace(/\briskLevel\b/gi, "risk level")
    .replace(/\bengine score\b/gi, "diagnostic pattern")
    .replace(/\bplanner\b/gi, "FixLens")
    .replace(/\bcluster\b/gi, "system area");

  if (!wantsPlaces) {
    text = text
      .replace(/.*\bnearby shop\b.*\n?/gi, "")
      .replace(/.*\bgo to a shop\b.*\n?/gi, "")
      .replace(/.*\bcheck location\b.*\n?/gi, "")
      .replace(/.*\bGPS\b.*\n?/g, "")
      .replace(/.*\bYelp\b.*\n?/gi, "")
      .replace(/.*\bmaps\b.*\n?/gi, "");
  }

  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!text) {
    return language === "spanish"
      ? "Necesito un poco más de información para orientar el diagnóstico con calma."
      : "I need a little more detail to guide the diagnosis calmly.";
  }

  return text;
}
/* =========================================================
   VISUAL PAYLOAD
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
    return emptyVisualPayload(visualLabels);
  }

  const issueTitle = pickLikelyIssue({
    diagnosticEngine,
    responsePlan,
    enginePack,
    language,
  });

  const riskLevel = normalizeRiskLevel(
    diagnosticEngine?.riskLevel || responsePlan?.severity || "medium"
  );

  const diagnostic_card = issueTitle
    ? {
        title: issueTitle,
        severity: riskLevel,
        severity_label: formatSeverityLabel(riskLevel, language),
        confidence: clamp01(Number(diagnosticEngine?.confidence ?? 0)),
        confidence_label: formatConfidenceLabel(
          clamp01(Number(diagnosticEngine?.confidence ?? 0)),
          language
        ),
        summary: buildDiagnosticSummary({
          language,
          issueTitle,
          diagnosticEngine,
          responsePlan,
        }),
        vehicle_identity: enginePack?.vehicle_identity || null,
        top_engine: diagnosticEngine?.topEngine || null,
        ui_variant: mapRiskToVariant(riskLevel),
      }
    : null;

  return {
    diagnostic_card,
    symptom_signals: buildSymptomSignals({ language, diagnosticEngine, responsePlan }),
    action_steps: buildActionSteps({
      language,
      diagnosticEngine,
      responsePlan,
      verifiedActions,
      verifiedWorkshops,
    }),
    warning_flag: buildWarningFlag({
      language,
      riskLevel,
      diagnosticEngine,
      responsePlan,
      reply,
    }),
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

function emptyVisualPayload(visualLabels) {
  return {
    diagnostic_card: null,
    symptom_signals: [],
    action_steps: [],
    warning_flag: null,
    visual_labels: visualLabels,
  };
}

function buildSymptomSignals({ language = "english", diagnosticEngine = {}, responsePlan = {} }) {
  const raw = [
    ...(Array.isArray(diagnosticEngine?.matchedSignals) ? diagnosticEngine.matchedSignals : []),
    ...(Array.isArray(diagnosticEngine?.symptomNotes) ? diagnosticEngine.symptomNotes : []),
    ...(Array.isArray(responsePlan?.evidence_summary) ? responsePlan.evidence_summary : []),
  ];

  return uniqueStrings(raw.map(cleanBulletText).filter(Boolean))
    .slice(0, 4)
    .map((text) => ({
      text: sanitizeSignalText(text),
      icon: inferSignalIcon(text),
      tone: inferSignalTone(text),
      language: normalizeSupportedLanguage(language),
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

  let steps = uniqueStrings([
    ...(Array.isArray(responsePlan?.tests) ? responsePlan.tests : []),
    ...(Array.isArray(diagnosticEngine?.firstChecks) ? diagnosticEngine.firstChecks : []),
    ...flattenVerifiedActionSteps(verifiedActions),
  ].map(cleanBulletText).filter(Boolean)).slice(0, 4);

  if (steps.length === 0 && verifiedWorkshops.length > 0) {
    steps = [
      lang === "spanish"
        ? "Buscar un taller confiable cercano para una inspección confirmatoria."
        : "Find a trusted nearby shop for a confirmatory inspection.",
    ];
  }

  if (steps.length === 0) {
    steps = [
      lang === "spanish"
        ? "Revisar el sistema relacionado con el síntoma."
        : "Inspect the system related to the symptom.",
    ];
  }

  return steps.map((text, index) => ({
    step: index + 1,
    text: sanitizeSignalText(text),
    image: mapStepToImage(text),
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

  const mustWarn =
    riskLevel === "high" ||
    /do not drive|avoid driving|unsafe/i.test(reply);

  if (!mustWarn) return null;

  return {
    show: true,
    level: riskLevel,
    message:
      lang === "spanish"
        ? "Evita conducirlo hasta revisarlo."
        : "Avoid driving it until this is checked.",
    ui_variant: mapRiskToVariant(riskLevel),
  };
}

/* =========================================================
   HELPERS (مختصر — بدون تغيير للـ search/GPS)
========================================================= */

function normalizeSupportedLanguage(value = "") {
  const v = String(value).toLowerCase();
  if (v.includes("spanish") || v.includes("es")) return "spanish";
  return "english";
}

function detectPreferredLanguageFromText(text = "") {
  if (/[áéíóúñ]/i.test(text)) return "spanish";
  return "english";
}

function hasMeaningfulText(value = "") {
  return typeof value === "string" && value.trim().length > 0;
}

function clamp01(value = 0) {
  return Math.max(0, Math.min(1, value));
}

function cleanBulletText(value = "") {
  return String(value).replace(/^[•\-\d.\)\s]+/, "").trim();
}

function uniqueStrings(arr = []) {
  return [...new Set(arr.map((x) => String(x).trim().toLowerCase()))];
}

function sanitizeSignalText(value = "") {
  return cleanBulletText(value);
}

function inferSignalIcon() {
  return "signal";
}

function inferSignalTone() {
  return "medium";
}

function mapRiskToVariant(risk) {
  if (risk === "high") return "danger";
  if (risk === "low") return "calm";
  return "warning";
}

function formatSeverityLabel(risk, lang) {
  if (lang === "spanish") return "Nivel de riesgo";
  return "Risk Level";
}

function formatConfidenceLabel(val, lang) {
  if (lang === "spanish") return "Confianza";
  return "Confidence";
}

function buildDiagnosticSummary({ issueTitle }) {
  return `FixLens detected signals consistent with ${issueTitle}`;
}

function pickLikelyIssue({ diagnosticEngine = {} }) {
  return diagnosticEngine?.topIssue || "mechanical issue";
}

function flattenVerifiedActionSteps() {
  return [];
}

function mapStepToImage() {
  return "default.png";
}
