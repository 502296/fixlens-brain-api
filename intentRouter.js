// intentRouter.js
// FixLens Intent Router v2.0
// Purpose:
// - Classify the current turn with stronger diagnostic continuity
// - Separate diagnosis, follow-up, purchase, safety, image, audio, and places requests
// - Support GPS / nearby / workshop routing with better case handoff
// - Keep one unified global routing brain

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.,?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastAssistantText(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") {
      return String(history[i]?.content || "").trim();
    }
  }
  return "";
}

function getRecentUserTexts(history = [], limit = 6) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user")
    .slice(-limit)
    .map((item) => String(item?.content || "").trim())
    .filter(Boolean);
}

function containsAny(text = "", terms = []) {
  const t = normalizeToken(text);
  return (Array.isArray(terms) ? terms : []).some((term) =>
    t.includes(normalizeToken(term))
  );
}

function extractFaultCodes(text = "") {
  const matches =
    String(text || "").match(/\b([PCUB][0-9]{3,4}|[A-Z][0-9]{4})\b/gi) || [];
  return [...new Set(matches.map((x) => x.toUpperCase()))].slice(0, 12);
}

function looksLikeDiagnosisText(text = "") {
  return containsAny(text, [
    "noise", "sound", "rattle", "knock", "ticking", "tick", "click", "clunk",
    "grind", "grinding", "squeal", "vibration", "shake", "shaking",
    "misfire", "stall", "idle", "engine", "brake", "steering",
    "overheat", "overheating", "smoke", "leak", "coolant", "oil",
    "battery", "alternator", "belt", "whine", "warning light",
    "check engine", "abs", "traction", "stability", "scanner", "scan tool",
    "fault code", "error code", "obd", "dashboard", "loss of power",
    "hard start", "long crank", "transmission", "gear slipping",

    "صوت", "طقطقة", "طرطقة", "تك تك", "نق", "خبط", "خشخشة", "صرير",
    "رجفة", "اهتزاز", "هزة", "تقطيع", "تنتيع", "تفتفة", "محرك",
    "مكينة", "فرامل", "دركسون", "ستيرنغ", "حرارة", "سخونة", "دخان",
    "تهريب", "تسريب", "لمبة", "تشيك", "عطل", "كود", "اكواد", "سكانر",
    "عداد", "لوحة", "مانع الانغلاق", "ثبات", "بطارية", "دينمو",
    "ضعف عزم", "ضعف سحب", "صعوبة تشغيل", "قير"
  ]);
}

function looksLikeActionQuestion(text = "") {
  return containsAny(text, [
    "how do i check", "how to check", "how do i test", "what should i test",
    "what do i inspect", "where do i start", "what should i do first",
    "how can i diagnose", "how can i test", "what should i inspect first",
    "what is the first step", "how do i narrow it down",

    "كيف افحص", "كيف أ فحص", "كيف أعمل فحص", "شلون افحص", "شلون أفحص",
    "من اين ابدأ", "من وين ابدأ", "شنو افحص", "شنو أفحص", "شنو اسوي",
    "ما الخطوة الاولى", "اول خطوة", "أول خطوة", "كيف اشيك", "كيف أشيك",
    "شلون أشيك", "شنو أجرب أول"
  ]);
}

function looksLikePlacesRequest(text = "") {
  return containsAny(text, [
    "near me", "nearby", "closest", "around me", "mechanic", "garage",
    "repair shop", "auto repair", "car repair", "parts store", "auto parts",
    "where is", "where can i find", "shop near", "maps", "address", "location",
    "phone number", "open now", "open today", "specialist", "tow", "towing",
    "brake shop", "electrical shop", "engine shop", "transmission shop",
    "dealer", "dealership", "workshop", "local shop",

    "اقرب", "أقرب", "بالقرب", "قريب", "قريبة", "ورشة", "ورش", "ميكانيكي",
    "ميكانيك", "كراج", "محل قطع", "قطع غيار", "عنوان", "موقع", "خرائط",
    "خريطة", "وين", "دلني", "ابعت لي ورشة", "ابعث لي ورشة", "ورشة قريبة",
    "ابعتلي ورشة", "ارسل لي ورشة", "ارسللي ورشة", "محل قريب",
    "سطحة", "سحب", "رقمهم", "مفتوح"
  ]);
}

function looksLikeExplicitPlacesHandoff(text = "") {
  return containsAny(text, [
    "yes send me nearby", "send me a nearby shop", "send nearby mechanic",
    "show me nearby", "find nearby", "send me a garage", "find me a mechanic",
    "find me a shop", "where should i take it", "who can fix this",
    "what shop should i go to", "can i drive it to a shop",

    "نعم ابعت لي ورشة", "نعم ابعث لي ورشة", "ابعت لي ورشة قريبة",
    "ابعث لي ورشة قريبة", "نعم ارسل لي ورشة", "نعم ابحث لي ورشة",
    "ابحث لي ورشة", "ابعتلي ورشة", "ارسل لي ورشة قريبة",
    "وين أوديها", "وين أصلحها", "منو يصلحها", "أقرب ورشة تصلحها",
    "دلني على محل", "جيبلي ميكانيكي"
  ]);
}

function looksLikeLocationProvided(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(t)) return true;
  if (/^\d{5}(?:-\d{4})?$/.test(t)) return true;

  return containsAny(t, [
    "street", "st.", "ave", "avenue", "road", "rd", "blvd", "suite",
    "شارع", "منطقة", "حي", "بغداد", "الرياض", "دبي", "عمان", "القاهرة",
    "kentucky", "louisville", "indianapolis", "new york", "california",
    "texas", "florida", "detroit", "dearborn", "houston", "chicago",
    "brooklyn", "queens", "manhattan", "zip", "zipcode", "postal"
  ]);
}

function looksLikePurchaseQuestion(text = "") {
  return containsAny(text, [
    "should i buy", "worth buying", "before i buy", "buy this car",
    "pre purchase", "pre-purchase", "used car inspection", "good deal",
    "walk away", "is this worth it", "should i take the risk",

    "اشتريها", "اشتري", "تنصحني اشتري", "قبل لا اشتري", "افحصها قبل الشراء",
    "فحص قبل الشراء", "اخذها لو اتركها", "تستاهل شراء", "خطر اشتريها"
  ]);
}

function looksLikeSafetyQuestion(text = "") {
  return containsAny(text, [
    "safe to drive", "can i drive it", "is it safe", "can i keep driving",
    "dangerous to drive", "okay to drive", "should i stop driving",

    "هل امشي بيها", "هل أسوقها", "آمنة", "أقدر أمشي", "أكدر أمشي",
    "أكدر أسوقها", "خطر", "أوقفها", "أقدر أستمر"
  ]);
}

function looksLikeImageRequest(text = "") {
  return containsAny(text, [
    "photo", "picture", "image", "dashboard", "scanner screen",
    "read this image", "read this photo", "look at this picture",

    "صورة", "هذه الصورة", "اقرأ الصورة", "شوف الصورة", "عداد", "لوحة",
    "شاشة السكانر"
  ]);
}

function looksLikeAudioRequest(text = "") {
  return containsAny(text, [
    "sound", "audio", "recording", "listen to this", "hear this noise",
    "what is this sound",

    "صوت", "تسجيل", "اسمع هذا", "شنو هذا الصوت", "هذا الصوت"
  ]);
}

function looksLikeExplanationOnly(text = "") {
  return containsAny(text, [
    "what does this code mean", "meaning of code", "explain code",
    "what does p", "what does c", "code meaning only",

    "شنو يعني هذا الكود", "معنى الكود", "اشرح الكود", "شنو معنى الكود"
  ]);
}

function lastAssistantAskedForLocation(history = []) {
  const last = getLastAssistantText(history);
  return containsAny(last, [
    "gps", "zip", "zipcode", "postal", "location", "area", "street",
    "maps", "city", "your location", "send your location", "share location",

    "حدد موقعك", "فعّل gps", "فعل gps", "اسم المنطقة", "اسم الشارع",
    "موقعك", "خرائط", "المدينة", "الرمز البريدي", "ارسل موقعك"
  ]);
}

function lastAssistantSuggestedShopOrSpecialist(history = []) {
  const last = getLastAssistantText(history);
  return containsAny(last, [
    "shop", "mechanic", "specialist", "repair", "garage", "tow",
    "workshop", "brake specialist", "electrical specialist",

    "ورشة", "ميكانيكي", "كراج", "محل", "اختصاص", "سطحة", "سحب"
  ]);
}

function conversationHasDiagnosisContext(history = [], currentText = "") {
  const recentUsers = getRecentUserTexts(history, 6).join(" | ");
  const combined = `${recentUsers} | ${String(currentText || "")}`;
  return (
    looksLikeDiagnosisText(combined) ||
    extractFaultCodes(combined).length > 0
  );
}

function conversationHasPlacesContext(history = []) {
  const recentUsers = getRecentUserTexts(history, 4).join(" | ");
  const lastAssistant = getLastAssistantText(history);
  const combined = `${recentUsers} | ${lastAssistant}`;

  return (
    looksLikePlacesRequest(combined) ||
    lastAssistantAskedForLocation(history) ||
    lastAssistantSuggestedShopOrSpecialist(history)
  );
}

function inferLocalSearchType({
  text = "",
  hasDiagnosisContext = false,
  hasPurchaseIntent = false,
}) {
  const t = normalizeToken(text);

  if (containsAny(t, ["tow", "towing", "سطحة", "سحب"])) {
    return "towing";
  }

  if (containsAny(t, ["parts store", "auto parts", "قطع غيار", "محل قطع"])) {
    return "parts_store";
  }

  if (
    containsAny(t, ["brake", "abs", "فرامل", "مانع الانغلاق", "ثبات"]) &&
    hasDiagnosisContext
  ) {
    return "brake_abs_specialist";
  }

  if (
    containsAny(t, ["battery", "alternator", "voltage", "بطارية", "دينمو"]) &&
    hasDiagnosisContext
  ) {
    return "auto_electrical_specialist";
  }

  if (
    containsAny(t, ["transmission", "gear", "قير"]) &&
    hasDiagnosisContext
  ) {
    return "transmission_specialist";
  }

  if (
    containsAny(t, ["engine", "misfire", "knock", "محرك", "تقطيع", "خبط"]) &&
    hasDiagnosisContext
  ) {
    return "engine_diagnostics_specialist";
  }

  if (hasPurchaseIntent) {
    return "prepurchase_inspection_shop";
  }

  return "general_repair_shop";
}

function computeRouteConfidence({
  mode = "general_question",
  hasCodes = false,
  diagnosisText = false,
  explicitPlaces = false,
  explicitPlacesHandoff = false,
  purchaseIntent = false,
  safetyIntent = false,
  hasImage = false,
  hasAudio = false,
  locationProvided = false,
}) {
  let score = 0.25;

  if (mode !== "general_question") score += 0.2;
  if (hasCodes) score += 0.15;
  if (diagnosisText) score += 0.15;
  if (explicitPlaces) score += 0.1;
  if (explicitPlacesHandoff) score += 0.1;
  if (purchaseIntent) score += 0.1;
  if (safetyIntent) score += 0.1;
  if (hasImage) score += 0.05;
  if (hasAudio) score += 0.05;
  if (locationProvided) score += 0.05;

  return Math.min(1, Number(score.toFixed(2)));
}

export function resolveIntent({
  text = "",
  history = [],
  hasImage = false,
  hasAudio = false,
}) {
  const normalized = normalizeToken(text);
  const detectedCodes = extractFaultCodes(text);

  const hasDiagnosisContext = conversationHasDiagnosisContext(history, text);
  const hasPlacesContext = conversationHasPlacesContext(history);

  const explicitPlaces = looksLikePlacesRequest(normalized);
  const explicitPlacesHandoff = looksLikeExplicitPlacesHandoff(normalized);
  const actionQuestion = looksLikeActionQuestion(normalized);
  const diagnosisText =
    looksLikeDiagnosisText(normalized) || detectedCodes.length > 0;
  const locationProvided = looksLikeLocationProvided(normalized);
  const locationAskedPreviously = lastAssistantAskedForLocation(history);

  const purchaseIntent = looksLikePurchaseQuestion(normalized);
  const safetyIntent = looksLikeSafetyQuestion(normalized);
  const imageTextHint = looksLikeImageRequest(normalized);
  const audioTextHint = looksLikeAudioRequest(normalized);
  const explanationOnly = looksLikeExplanationOnly(normalized);

  let mode = "general_question";

  if (hasImage && !text.trim()) {
    mode = "image_diagnosis";
  } else if (hasAudio && !text.trim()) {
    mode = "audio_diagnosis";
  } else if (purchaseIntent && (diagnosisText || detectedCodes.length > 0 || hasImage)) {
    mode = "purchase_diagnosis";
  } else if (purchaseIntent) {
    mode = "purchase_question";
  } else if (safetyIntent && hasDiagnosisContext) {
    mode = "drive_safety_followup";
  } else if (safetyIntent) {
    mode = "drive_safety_question";
  } else if (explicitPlacesHandoff) {
    mode = "places_request";
  } else if (locationAskedPreviously && locationProvided) {
    mode = "places_followup";
  } else if (explicitPlaces && hasDiagnosisContext) {
    mode = "places_handoff_from_diagnosis";
  } else if (explicitPlaces) {
    mode = "places_request";
  } else if (actionQuestion && hasDiagnosisContext) {
    mode = "diagnosis_followup";
  } else if (diagnosisText && hasDiagnosisContext) {
    mode = "diagnosis_followup";
  } else if (diagnosisText) {
    mode = "diagnosis_initial";
  } else if (hasImage && imageTextHint && hasDiagnosisContext) {
    mode = "image_followup_diagnosis";
  } else if (hasImage) {
    mode = "image_diagnosis";
  } else if (hasAudio && audioTextHint && hasDiagnosisContext) {
    mode = "audio_followup_diagnosis";
  } else if (hasAudio) {
    mode = "audio_diagnosis";
  } else if (hasPlacesContext && locationProvided) {
    mode = "places_followup";
  }

  const isDiagnosis =
    mode === "diagnosis_initial" ||
    mode === "diagnosis_followup" ||
    mode === "image_diagnosis" ||
    mode === "audio_diagnosis" ||
    mode === "image_followup_diagnosis" ||
    mode === "audio_followup_diagnosis" ||
    mode === "purchase_diagnosis" ||
    mode === "drive_safety_followup" ||
    mode === "drive_safety_question";

  const isFollowup =
    mode === "diagnosis_followup" ||
    mode === "places_followup" ||
    mode === "image_followup_diagnosis" ||
    mode === "audio_followup_diagnosis" ||
    mode === "drive_safety_followup";

  const isPlaces =
    mode === "places_request" ||
    mode === "places_followup" ||
    mode === "places_handoff_from_diagnosis";

  const localSearchType = isPlaces
    ? inferLocalSearchType({
        text: normalized,
        hasDiagnosisContext,
        hasPurchaseIntent: purchaseIntent,
      })
    : null;

  const shouldUseGpsOrLocation =
    isPlaces ||
    mode === "places_handoff_from_diagnosis" ||
    (locationAskedPreviously && locationProvided);

  const shouldPreserveDiagnosisState =
    hasDiagnosisContext ||
    isDiagnosis ||
    mode === "places_handoff_from_diagnosis";

  const shouldMergeMediaIntoCase =
    (hasImage || hasAudio) && (hasDiagnosisContext || diagnosisText || purchaseIntent || safetyIntent);

  return {
    mode,

    isDiagnosis,
    isFollowup,
    isActionQuestion: mode === "diagnosis_followup" && actionQuestion,
    isPlaces,

    isPurchase: mode === "purchase_question" || mode === "purchase_diagnosis",
    isSafety:
      mode === "drive_safety_question" || mode === "drive_safety_followup",

    explicitPlaces,
    explicitPlacesHandoff,
    locationProvided,
    locationAskedPreviously,

    hasDiagnosisContext,
    hasPlacesContext,

    hasImage,
    hasAudio,
    imageTextHint,
    audioTextHint,

    explanationOnly,
    detectedCodes,

    shouldUseGpsOrLocation,
    shouldPreserveDiagnosisState,
    shouldMergeMediaIntoCase,

    localSearchType,

    route_confidence: computeRouteConfidence({
      mode,
      hasCodes: detectedCodes.length > 0,
      diagnosisText,
      explicitPlaces,
      explicitPlacesHandoff,
      purchaseIntent,
      safetyIntent,
      hasImage,
      hasAudio,
      locationProvided,
    }),
  };
}
