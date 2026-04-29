// service.js — FixLens Brain v16
// Stable, search/GPS-aware, clean natural output, no raw links, no report-style replies

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

    const dialect = language === "spanish" ? "latin-american-spanish" : "us-english";

    const wantsPlaces =
      primaryIntent === "places" ||
      primaryIntent === "hybrid" ||
      Boolean(ruleIntent.places) ||
      Boolean(routedIntent.isPlaces);

    const needsLocation = wantsPlaces && !hasUsableLocation(location, userText);

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

    const verifiedData = Array.isArray(search?.verified_data) ? search.verified_data : [];
    const verifiedActions = Array.isArray(search?.verified_actions) ? search.verified_actions : [];
    const verifiedWorkshops = Array.isArray(search?.verified_workshops) ? search.verified_workshops : [];

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
      userText,
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
- Keep the tone calm, premium, practical, and human.
- Do not scare the driver.
- Do not over-ask questions.
- Ask only one follow-up question if it truly changes the next step.

Nearby/place response rules:
- Only mention nearby places if the user clearly asked for nearby help.
- If the user asks for nearby places, mechanics, shops, towing, or someone who can fix it, DO NOT return numbered lists, bullet points, markdown links, raw URLs, or Google Maps URLs.
- Do NOT say "Here are some places you might consider."
- Mention places naturally inside one short paragraph.
- Include phone numbers only if useful and available.
- Recommend the type of shop that fits the symptom.
- If search results look unrelated to automotive repair, say the results do not look trustworthy yet and suggest searching again for a real auto repair shop.
- Avoid handyman, appliance, IT, HVAC, plumbing, cleaning, or unrelated service businesses unless the result clearly says automotive repair.

Write naturally like a real expert mechanic speaking to a driver.

Do NOT use titles like "Diagnosis", "Possible causes", etc.
Do NOT use bullet points or numbered lists unless absolutely necessary.

Structure the answer as a smooth explanation:
- Start with a calm understanding of the symptom
- Explain what it likely relates to in simple terms
- Suggest what to check in a natural flow
- End with calm driving advice

Keep it:
- Human
- Clear
- Professional
- Not robotic
- Not formatted like a report
`;

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
- numbered lists
- bullet lists
- markdown links
- raw URLs
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
  userText = "",
}) {
  const lang = normalizeSupportedLanguage(language);

  if (wantsPlaces) {
    return buildCleanNearbyResponse({
      language: lang,
      verifiedWorkshops,
      userText,
    });
  }

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
      "an idle-quality issue"
  );

  if (lang === "spanish") {
    return sanitizeUserFacingReply(
      `
Por lo que describes, esto apunta más hacia un problema de calidad de ralentí que a suspensión o frenos. Yo empezaría por el sistema de encendido, especialmente bujías o bobinas, porque pueden hacer que el motor se sienta áspero en parado antes de que aparezca una luz de advertencia.

Si eso está bien, revisaría si hay una pequeña fuga de vacío alrededor de la admisión, porque aire no medido también puede volver inestable el ralentí.

Por ahora, manejar suave normalmente está bien, pero si la vibración empeora, pierde fuerza, o la luz de check-engine empieza a parpadear, yo reduciría el uso hasta revisarlo.
`.trim(),
      { language: lang, wantsPlaces }
    );
  }

  return sanitizeUserFacingReply(
    `
From what you’re describing, this points more toward ${issue.toLowerCase()} than a suspension or brake problem. I’d start on the ignition side first — spark plugs or a weak coil can make the engine feel rough at idle before it becomes bad enough to turn on a warning light.

If that checks out, I’d look for a small vacuum leak around the intake hoses, because unmetered air can make the idle unstable too.

For now, gentle driving is usually fine, but if the shaking gets stronger, the car loses power, or the check-engine light starts flashing, I’d stop driving and get it checked.
`.trim(),
    { language: lang, wantsPlaces }
  );
}

function buildCleanNearbyResponse({ language = "english", verifiedWorkshops = [], userText = "" }) {
  const lang = normalizeSupportedLanguage(language);
  const relevant = filterAutomotiveWorkshops(verifiedWorkshops).slice(0, 3);

  if (lang === "spanish") {
    if (relevant.length === 0) {
      return "No confiaría todavía en esos resultados porque no parecen claramente talleres de reparación automotriz. Yo buscaría de nuevo un taller mecánico real o un taller Toyota/auto repair bien calificado y les diría que el carro tiembla en ralentí pero mejora al avanzar, para que lo escaneen y revisen encendido antes de cambiar piezas.";
    }

    const shopsText = naturalWorkshopList(relevant, lang);
    return sanitizeUserFacingReply(
      `Sí, buscaría un taller mecánico general bien calificado, no un servicio genérico. Para este síntoma, lo importante es que puedan escanear el carro y revisar encendido, bujías, bobinas y posible fuga de vacío. Cerca de ti aparecen opciones como ${shopsText}. Yo llamaría primero y les diría que el carro tiembla en ralentí pero mejora al avanzar, y preguntaría si pueden diagnosticar eso antes de cambiar piezas.`,
      { language: lang, wantsPlaces: true }
    );
  }

  if (relevant.length === 0) {
    return "I wouldn’t trust these results yet because they don’t look clearly automotive-related. I’d search again for a real auto repair shop, Toyota specialist, or well-rated general mechanic, then tell them the car shakes at idle but smooths out when driving so they can scan it and check the ignition system before replacing parts.";
  }

  const shopsText = naturalWorkshopList(relevant, lang);

  return sanitizeUserFacingReply(
    `Yes — for this symptom, I’d look for a well-rated general auto repair shop rather than a random service listing. The right place should be able to scan the car and check the ignition side, especially plugs, coils, and a possible small vacuum leak. Nearby, I’d start with ${shopsText}. I’d call first and describe it exactly like this: the car shakes at idle but smooths out once it starts moving, and you want it diagnosed before any parts are replaced.`,
    { language: lang, wantsPlaces: true }
  );
}

function sanitizeUserFacingReply(reply = "", { language = "english", wantsPlaces = false } = {}) {
  let text = String(reply || "").trim();

  text = text
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^\s*\d+\.\s*/gm, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\bMost likely cause\s*:\s*/gi, "")
    .replace(/^Optional:\s*/gim, "")
    .replace(/^If needed:\s*/gim, "")
    .replace(/^Next question:\s*$/gim, "")
    .replace(/^Diagnosis:\s*/gim, "")
    .replace(/^Possible causes:\s*/gim, "")
    .replace(/^What to check first:\s*/gim, "")
    .replace(/^Driving condition:\s*/gim, "")
    .replace(/^Nearby options:\s*/gim, "")
    .replace(/^Recommendation:\s*/gim, "")
    .replace(/^Safety:\s*/gim, "")
    .replace(/^Conclusion:\s*/gim, "")
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
      .replace(/.*\bGoogle Maps\b.*\n?/gi, "")
      .replace(/.*\bmaps\b.*\n?/gi, "");
  }

  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.])/g, "$1")
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
  const safetyAdvice = String(responsePlan?.safety_advice || "").trim();
  const cautionFlags = Array.isArray(diagnosticEngine?.cautionFlags)
    ? diagnosticEngine.cautionFlags.filter(Boolean)
    : [];

  const mustWarn =
    riskLevel === "high" ||
    /do not drive|don't drive|avoid driving|stop driving|unsafe to drive|tow/i.test(reply) ||
    /no conduzcas|evita conducir|grúa|remolque/i.test(reply) ||
    cautionFlags.length > 0 ||
    Boolean(safetyAdvice);

  if (!mustWarn) return null;

  const message =
    safetyAdvice ||
    cautionFlags[0] ||
    (lang === "spanish"
      ? riskLevel === "high"
        ? "Evita conducirlo hasta revisar esta falla."
        : "Conduce con cuidado y revisa esta falla pronto."
      : riskLevel === "high"
        ? "Avoid driving it until this fault is checked."
        : "Drive carefully and have this fault checked soon.");

  return {
    show: true,
    level: riskLevel,
    message: sanitizeSignalText(message),
    ui_variant: mapRiskToVariant(riskLevel),
  };
}

/* =========================================================
   INTENT
========================================================= */

async function classifyIntentCheap({ text = "", location = null, ruleIntent = {}, routedIntent = {} }) {
  const lower = String(text || "").toLowerCase();

  const localWords =
    /\b(near me|nearby|shop|mechanic|garage|tow|towing|address|maps|location|parts store|repair shop|someone who can fix|who can fix|fix it near|auto repair)\b/i;
  const spanishLocal =
    /\b(taller|mecánico|mecanico|cerca|grúa|grua|remolque|ubicación|ubicacion)\b/i;

  const wantsPlaces =
    localWords.test(lower) ||
    spanishLocal.test(lower) ||
    Boolean(ruleIntent?.places) ||
    Boolean(routedIntent?.isPlaces);

  return {
    primaryIntent: wantsPlaces ? "hybrid" : "diagnosis",
    needsSearch: wantsPlaces,
    askForLocation: wantsPlaces && !hasUsableLocation(location, text),
    userLanguage: detectPreferredLanguageFromText(text),
  };
}

/* =========================================================
   HELPERS
========================================================= */

function extractUserText(body = {}) {
  if (typeof body.text === "string") return body.text;
  if (typeof body.message === "string") return body.message;
  if (typeof body.prompt === "string") return body.prompt;
  if (typeof body.input === "string") return body.input;
  if (typeof body.query === "string") return body.query;

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    if (typeof last?.content === "string") return last.content;
    if (Array.isArray(last?.content)) {
      return last.content.find((c) => c?.type === "text")?.text || "";
    }
  }

  return "";
}

function extractImage(body = {}) {
  return body.image_base64 || body.image_base_64 || body.image || "";
}

function extractAudio(body = {}) {
  return body.audio_base64 || body.audio_base_64 || body.audio || "";
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
  return /\b\d{5}(?:-\d{4})?\b/.test(t) || /(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)/.test(t);
}

function normalizeSupportedLanguage(value = "") {
  const v = String(value || "").toLowerCase();
  if (v.includes("spanish") || v.includes("españ") || v === "es" || v === "spa") return "spanish";
  return "english";
}

function detectPreferredLanguageFromText(text = "") {
  const t = String(text || "");
  if (/[áéíóúñü¿¡]/i.test(t)) return "spanish";

  const lower = t.toLowerCase();
  const hints = [
    "carro",
    "coche",
    "mecánico",
    "mecanico",
    "ruido",
    "vibra",
    "tiembla",
    "taller",
    "dirección",
    "direccion",
  ];

  return hints.some((w) => lower.includes(w)) ? "spanish" : "english";
}

function enrichTextWithVehicle(text = "", vehicle = {}) {
  const prefix = [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.engine]
    .filter(Boolean)
    .join(" ")
    .trim();

  return prefix ? `${prefix}\n${text || ""}`.trim() : text || "";
}

function buildOpenAIMessages({ systemPrompt, history = [], contextBlock, image }) {
  let messages = [{ role: "system", content: systemPrompt }];

  const sanitized = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user" || item?.role === "assistant")
    .slice(-8)
    .map((item) => ({
      role: item.role,
      content:
        typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content || ""),
    }));

  messages = messages.concat(sanitized);

  if (image) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: contextBlock },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}` } },
      ],
    });
  } else {
    messages.push({ role: "user", content: contextBlock });
  }

  return messages;
}

function defaultRuleIntent({ image, audio }) {
  return {
    primaryIntent: "diagnosis",
    diagnosis: true,
    places: false,
    image: Boolean(image),
    audio: Boolean(audio),
    needsSearch: false,
    askForLocation: false,
    detectedCodes: [],
  };
}

function defaultRoutedIntent({ location, image, audio }) {
  return {
    mode: "diagnosis",
    isDiagnosis: true,
    isPlaces: false,
    locationProvided: Boolean(location),
    hasImage: Boolean(image),
    hasAudio: Boolean(audio),
  };
}

function defaultDiagnosticEngine() {
  return {
    scope: "general",
    topIssue: null,
    topEngine: null,
    confidence: 0.18,
    riskLevel: "low",
    matchedSignals: [],
    matchedKeywords: [],
    firstChecks: [],
    mechanism: "",
    symptomNotes: [],
    commonMisreads: [],
    doNotConfuseWith: [],
    rankedFindings: [],
    cautionFlags: [],
  };
}

function baseResponse({
  ok = true,
  reply,
  intent = "general",
  language = "english",
  dialect = "us-english",
  needs_location = false,
}) {
  return {
    ok,
    reply,
    intent,
    language,
    dialect,
    searched: false,
    needs_location,
    diagnostic_card: null,
    symptom_signals: [],
    action_steps: [],
    warning_flag: null,
    visual_labels: buildVisualLabels(language),
  };
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    console.log("Safe call failed:", error?.message || error);
    return fallback;
  }
}

async function safeAsyncCall(fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    console.log("Safe async call failed:", error?.message || error);
    return fallback;
  }
}

function formatSearchDataForContext(items = [], maxItems = 4) {
  return (Array.isArray(items) ? items : []).slice(0, maxItems).map((item, i) => ({
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
    primary_type: item?.primary_type || "",
    mode: item?.mode || "",
  }));
}

function formatVerifiedActionsForContext(items = [], maxItems = 4) {
  return (Array.isArray(items) ? items : []).slice(0, maxItems).map((item, i) => ({
    index: i + 1,
    id: item?.id || "",
    match_score: item?.match_score ?? null,
    diagnostic_priority: item?.diagnostic_priority ?? null,
    safety_level: item?.safety_level || "",
    match_type: item?.match_type || [],
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

function filterAutomotiveWorkshops(items = []) {
  return (Array.isArray(items) ? items : []).filter(isAutomotiveWorkshop);
}

function isAutomotiveWorkshop(item = {}) {
  const text = [
    item?.name,
    item?.title,
    item?.primary_type,
    item?.type,
    item?.category,
    item?.categories,
    item?.tags,
    item?.source,
    item?.description,
  ]
    .flat()
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const automotive =
    /\b(auto|automotive|mechanic|garage|repair|car repair|vehicle|toyota|tires?|brakes?|transmission|muffler|oil|engine|collision|body shop|towing|service center)\b/i;

  const unrelated =
    /\b(handyman|appliance|it\b|computer|hvac|plumbing|cleaning|electrician|roofing|lawn|landscap|pest|moving|locksmith)\b/i;

  if (automotive.test(text) && !unrelated.test(text)) return true;
  return false;
}

function naturalWorkshopList(items = [], language = "english") {
  const clean = items
    .slice(0, 3)
    .map((x) => {
      const name = x?.name || x?.title || "a nearby auto repair shop";
      const phone = x?.phone ? ` (${x.phone})` : "";
      const address = x?.address ? ` on ${shortAddress(x.address)}` : "";
      return `${name}${address}${phone}`;
    })
    .filter(Boolean);

  if (clean.length === 0) {
    return language === "spanish" ? "un taller mecánico cercano" : "a nearby auto repair shop";
  }

  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} or ${clean[1]}`;
  return `${clean[0]}, ${clean[1]}, or ${clean[2]}`;
}

function shortAddress(address = "") {
  return String(address || "")
    .replace(/\bUnited States\b/gi, "")
    .replace(/\s*,\s*USA\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickLikelyIssue({ diagnosticEngine = {}, responsePlan = {}, enginePack = {}, language = "english" }) {
  const issue = cleanIssueTitle(
    responsePlan?.strongest_hypothesis ||
      diagnosticEngine?.topIssue ||
      firstNonEmptyString(responsePlan?.likely_causes) ||
      firstRankedFindingTitle(diagnosticEngine?.rankedFindings)
  );

  if (issue) return issue;

  const vehicle = enginePack?.vehicle_identity ? `${enginePack.vehicle_identity} ` : "";
  return normalizeSupportedLanguage(language) === "spanish"
    ? `${vehicle}ruta probable de falla mecánica`.trim()
    : `${vehicle}probable mechanical fault path`.trim();
}

function cleanIssueTitle(value = "") {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\-\–\—•\d.\)\s]+/, "")
    .replace(/\bcheck engine\b/gi, "check-engine light")
    .replace(/\bcheck_engine\b/gi, "check-engine light")
    .trim();
}

function sanitizeSignalText(value = "") {
  return cleanIssueTitle(cleanBulletText(value));
}

function buildDiagnosticSummary({ language = "english", issueTitle = "", diagnosticEngine = {} }) {
  const lang = normalizeSupportedLanguage(language);
  const matchedSignals = Array.isArray(diagnosticEngine?.matchedSignals)
    ? diagnosticEngine.matchedSignals.filter(Boolean).map(sanitizeSignalText)
    : [];

  if (lang === "spanish") {
    return matchedSignals.length > 0
      ? `FixLens detectó señales compatibles con ${issueTitle.toLowerCase()}.`
      : "FixLens detectó un patrón que merece una revisión específica.";
  }

  return matchedSignals.length > 0
    ? `FixLens detected signals consistent with ${issueTitle.toLowerCase()}.`
    : "FixLens detected a pattern that deserves targeted inspection.";
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
  return first?.title || first?.issue || first?.issueName || first?.name || "";
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
    if (!normalized || seen.has(normalized)) continue;
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

function trimLongReply(value = "") {
  const text = String(value || "").trim();
  if (text.length <= 1400) return text;
  return text.slice(0, 1400).trim() + "...";
}

function mapStepToImage(text = "") {
  const t = String(text || "").toLowerCase();

  if (t.includes("fluid") || t.includes("steering")) return "power_steering_fluid.png";
  if (t.includes("belt")) return "engine_belt.png";
  if (t.includes("battery") || t.includes("voltage")) return "car_battery.png";
  if (t.includes("brake")) return "brake_system.png";
  if (t.includes("coolant") || t.includes("overheat")) return "cooling_system.png";
  if (t.includes("oil")) return "engine_oil.png";
  if (t.includes("spark") || t.includes("coil") || t.includes("misfire")) return "ignition_system.png";

  return "default_tool.png";
}

function buildLocationPrompt({ language = "english", routedIntent = {} }) {
  const lang = normalizeSupportedLanguage(language);

  if (lang === "spanish") {
    if (routedIntent?.localSearchType === "towing") {
      return "Envíame tu ciudad, código postal o ubicación para buscar una grúa cercana.";
    }
    return "Envíame tu ciudad, código postal o ubicación para buscar un taller cercano.";
  }

  if (routedIntent?.localSearchType === "towing") {
    return "Send me your city, ZIP code, or GPS location so I can find a nearby towing service.";
  }

  return "Send me your city, ZIP code, or GPS location so I can find a nearby shop.";
}
