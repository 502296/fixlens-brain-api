// intentRouter.js
// FixLens Intent Router v1.0
// Purpose:
// - Classify the user's current turn more intelligently
// - Separate diagnosis follow-up from places/shop requests
// - Improve continuity inside the same case

function normalizeToken(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.?]/gu, " ")
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

function getRecentUserTexts(history = [], limit = 4) {
  return (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user")
    .slice(-limit)
    .map((item) => String(item?.content || "").trim())
    .filter(Boolean);
}

function containsAny(text = "", terms = []) {
  const t = normalizeToken(text);
  return terms.some((term) => t.includes(normalizeToken(term)));
}

function looksLikeDiagnosisText(text = "") {
  return containsAny(text, [
    "noise", "sound", "rattle", "knock", "ticking", "click", "clunk",
    "grind", "squeal", "vibration", "shake", "misfire", "stall",
    "idle", "engine", "brake", "steering", "overheat", "smoke",
    "leak", "check engine", "code", "codes",
    "صوت", "طقطقة", "طرطقة", "تك تك", "نق", "خبط", "خشخشة", "صرير",
    "رجفة", "اهتزاز", "هزة", "تقطيع", "تنتيع", "تفتفة", "محرك",
    "مكينة", "فرامل", "دركسون", "ستيرنغ", "حرارة", "سخونة", "دخان",
    "تهريب", "تسريب", "لمبة", "تشيك", "عطل", "كود", "اكواد"
  ]);
}

function looksLikeActionQuestion(text = "") {
  return containsAny(text, [
    "how do i check", "how to check", "how do i test", "what should i test",
    "what do i inspect", "where do i start", "what should i do first",
    "how can i diagnose", "how can i test",
    "كيف افحص", "كيف أ فحص", "كيف أعمل فحص", "شلون افحص", "شلون أفحص",
    "من اين ابدأ", "من وين ابدأ", "شنو افحص", "شنو أفحص", "شنو اسوي", "ما الخطوة الاولى",
    "اول خطوة", "أول خطوة", "كيف اشيك", "كيف أشيك"
  ]);
}

function looksLikePlacesRequest(text = "") {
  return containsAny(text, [
    "near me", "nearby", "closest", "around me", "mechanic", "garage",
    "repair shop", "auto repair", "car repair", "parts store", "auto parts",
    "where is", "where can i find", "shop near", "maps", "address", "location",
    "اقرب", "أقرب", "بالقرب", "قريب", "قريبة", "ورشة", "ورش", "ميكانيكي",
    "ميكانيك", "كراج", "محل قطع", "قطع غيار", "عنوان", "موقع", "خرائط", "خريطة",
    "وين", "دلني", "ابعت لي ورشة", "ابعث لي ورشة", "ورشة قريبة", "ابعت لي محل"
  ]);
}

function looksLikeExplicitPlacesHandoff(text = "") {
  return containsAny(text, [
    "yes send me nearby", "send me a nearby shop", "send nearby mechanic",
    "show me nearby", "find nearby", "send me a garage",
    "نعم ابعت لي ورشة", "نعم ابعث لي ورشة", "ابعت لي ورشة قريبة",
    "ابعث لي ورشة قريبة", "نعم ارسل لي ورشة", "نعم ابحث لي ورشة",
    "ابحث لي ورشة", "ابعتلي ورشة", "ارسل لي ورشة قريبة"
  ]);
}

function looksLikeLocationProvided(text = "") {
  const t = String(text || "").trim();
  if (!t) return false;

  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(t)) return true;
  if (/^\d{5}(?:-\d{4})?$/.test(t)) return true;

  return containsAny(t, [
    "street", "st.", "ave", "avenue", "road", "rd", "blvd",
    "شارع", "منطقة", "حي", "بغداد", "الرياض", "دبي", "عمان", "القاهرة",
    "kentucky", "louisville", "indianapolis", "new york", "california", "texas"
  ]);
}

function lastAssistantAskedForLocation(history = []) {
  const last = getLastAssistantText(history);
  return containsAny(last, [
    "gps", "zip", "zipcode", "postal", "location", "area", "street", "maps",
    "حدد موقعك", "فعّل gps", "فعل gps", "اسم المنطقة", "اسم الشارع", "موقعك", "خرائط"
  ]);
}

function conversationHasDiagnosisContext(history = [], currentText = "") {
  const recentUsers = getRecentUserTexts(history, 4).join(" | ");
  return looksLikeDiagnosisText(recentUsers) || looksLikeDiagnosisText(currentText);
}

export function resolveIntent({
  text = "",
  history = [],
  hasImage = false,
  hasAudio = false,
}) {
  const normalized = normalizeToken(text);
  const hasDiagnosisContext = conversationHasDiagnosisContext(history, text);

  const explicitPlaces = looksLikePlacesRequest(normalized);
  const explicitPlacesHandoff = looksLikeExplicitPlacesHandoff(normalized);
  const actionQuestion = looksLikeActionQuestion(normalized);
  const diagnosisText = looksLikeDiagnosisText(normalized);
  const locationProvided = looksLikeLocationProvided(normalized);
  const locationAskedPreviously = lastAssistantAskedForLocation(history);

  let mode = "general_question";

  if (hasImage && !text.trim()) {
    mode = "image_diagnosis";
  } else if (hasAudio && !text.trim()) {
    mode = "audio_diagnosis";
  } else if (explicitPlacesHandoff) {
    mode = "places_request";
  } else if (locationAskedPreviously && locationProvided) {
    mode = "places_followup";
  } else if (actionQuestion && hasDiagnosisContext) {
    mode = "diagnosis_followup";
  } else if (diagnosisText && hasDiagnosisContext) {
    mode = "diagnosis_followup";
  } else if (diagnosisText) {
    mode = "diagnosis_initial";
  } else if (explicitPlaces) {
    mode = "places_request";
  } else if (hasImage) {
    mode = "image_diagnosis";
  } else if (hasAudio) {
    mode = "audio_diagnosis";
  }

  return {
    mode,
    isDiagnosis:
      mode === "diagnosis_initial" ||
      mode === "diagnosis_followup" ||
      mode === "image_diagnosis" ||
      mode === "audio_diagnosis",
    isFollowup:
      mode === "diagnosis_followup" ||
      mode === "places_followup",
    isActionQuestion: mode === "diagnosis_followup" && actionQuestion,
    isPlaces:
      mode === "places_request" ||
      mode === "places_followup",
    explicitPlaces,
    explicitPlacesHandoff,
    locationProvided,
    locationAskedPreviously,
  };
}
