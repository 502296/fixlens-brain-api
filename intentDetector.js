// intentDetector.js
// FixLens Global Intent Detector v2.0
// One unified global intent layer for diagnosis, places, GPS, purchase, safety, image, and audio cases

export function detectIntent({
  text = "",
  history = [],
  location = null,
} = {}) {
  const t = normalizeText(text);
  const recentHistory = normalizeText(
    (Array.isArray(history) ? history : [])
      .slice(-6)
      .map((item) => {
        if (typeof item?.content === "string") {
          return item.content;
        }
        return JSON.stringify(item?.content || "");
      })
      .join(" ")
  );

  const full = `${t} ${recentHistory}`.trim();

  const languageProfile = detectLanguageProfile(full);
  const detectedCodes = extractFaultCodes(full);

  const symptomPatterns = [
    "noise",
    "knock",
    "tick",
    "ticking",
    "rattle",
    "shake",
    "shaking",
    "vibration",
    "misfire",
    "smoke",
    "leak",
    "overheat",
    "overheating",
    "stall",
    "stalling",
    "hesitation",
    "rough idle",
    "hard start",
    "long crank",
    "no start",
    "check engine",
    "engine light",
    "transmission",
    "brake",
    "brakes",
    "steering",
    "coolant",
    "oil",
    "engine",
    "battery",
    "alternator",
    "belt",
    "whine",
    "grinding",
    "clicking",
    "warning light",
    "dashboard",
    "scanner",
    "scan tool",
    "fault code",
    "error code",
    "obd",
    "car shakes",
    "weak acceleration",
    "loss of power",
    "abs",
    "traction",
    "stability",
    "esp",
    "vsc",

    "صوت",
    "دق",
    "خبط",
    "طقطقة",
    "تك تك",
    "رجفة",
    "اهتزاز",
    "تقطيع",
    "تفتفة",
    "تنتيع",
    "دخان",
    "تهريب",
    "تسريب",
    "حرارة",
    "سخونة",
    "يطفي",
    "يطفى",
    "تطفي",
    "يتأخر بالتشغيل",
    "صعوبة تشغيل",
    "لمبة المكينة",
    "لمبة المحرك",
    "لمبة تشيك",
    "لمبة check",
    "قير",
    "فرامل",
    "دركسون",
    "بطارية",
    "دينمو",
    "سكانر",
    "كود",
    "اكواد",
    "عداد",
    "لوحة",
    "مانع الانغلاق",
    "ثبات",
    "سحب ضعيف",
    "ضعف عزم",
  ];

  const placePatterns = [
    "near me",
    "nearby",
    "closest",
    "around",
    "address",
    "location",
    "shop",
    "repair",
    "garage",
    "mechanic",
    "tow",
    "towing",
    "parts store",
    "auto parts",
    "map",
    "maps",
    "phone number",
    "open now",
    "open today",
    "where can i take it",
    "where should i go",
    "local shop",
    "specialist",
    "brake shop",
    "electrical shop",
    "engine shop",
    "workshop",

    "اقرب",
    "بالقرب",
    "قريب مني",
    "مكاني",
    "موقعي",
    "ورشة",
    "ميكانيكي",
    "كراج",
    "ساحب",
    "سطحة",
    "قطع غيار",
    "خريطة",
    "خرائط",
    "رقمهم",
    "عنوانهم",
    "مفتوح",
    "وين أوديها",
    "وين أروح",
    "محل",
  ];

  const hybridPatterns = [
    "where should i take it",
    "can i drive it to a shop",
    "what shop should i go to",
    "find me a mechanic",
    "who can fix this",
    "best shop for this",
    "can i take it nearby",
    "need a shop for this",

    "وين أوديها",
    "وين أروح",
    "أقدر أمشي بيها للورشة",
    "جيبلي ميكانيكي",
    "منو يصلحها",
    "أقرب ورشة تصلحها",
    "وين أصلحها",
  ];

  const purchasePatterns = [
    "should i buy",
    "worth buying",
    "before i buy",
    "buy this car",
    "pre purchase",
    "pre-purchase",
    "used car inspection",
    "is this a good deal",
    "walk away",
    "good buy",
    "bad buy",

    "اشتريها",
    "اشتري",
    "تنصحني اشتري",
    "قبل لا اشتري",
    "افحصها قبل الشراء",
    "فحص قبل الشراء",
    "تستاهل شراء",
    "اخذها لو اتركها",
  ];

  const safetyPatterns = [
    "safe to drive",
    "can i drive it",
    "is it safe",
    "drive it like this",
    "okay to keep driving",
    "can i keep driving",
    "dangerous to drive",

    "هل امشي بيها",
    "هل أسوقها",
    "آمنة",
    "أقدر أمشي",
    "خطر",
    "أكدر أمشي",
    "أكدر أسوقها",
  ];

  const imagePatterns = [
    "photo",
    "picture",
    "image",
    "dashboard",
    "scanner screen",
    "read this image",
    "read this photo",
    "what does this picture show",

    "صورة",
    "اقرأ الصورة",
    "هذه الصورة",
    "عداد",
    "لوحة",
    "شاشة السكانر",
  ];

  const audioPatterns = [
    "sound",
    "noise",
    "audio",
    "recording",
    "listen to this",
    "hear this",
    "what is this sound",

    "صوت",
    "تسجيل",
    "اسمع هذا",
    "شنو هذا الصوت",
    "هذا الصوت",
  ];

  const explanationPatterns = [
    "what does this code mean",
    "meaning of code",
    "explain code",
    "what is p0",
    "what is c1",
    "what does obd code mean",

    "شنو يعني هذا الكود",
    "معنى الكود",
    "اشرح الكود",
    "شنو معنى",
  ];

  const hasVehicleSymptom =
    containsAny(full, symptomPatterns) || detectedCodes.length > 0;

  const hasPlaceHint = containsAny(full, placePatterns);
  const hasHybridHint = containsAny(full, hybridPatterns);
  const hasPurchaseHint = containsAny(full, purchasePatterns);
  const hasSafetyHint = containsAny(full, safetyPatterns);
  const hasImageHint = containsAny(full, imagePatterns);
  const hasAudioHint = containsAny(full, audioPatterns);
  const hasExplanationHint = containsAny(full, explanationPatterns);

  const hasLocationHint =
    Boolean(location) || hasStructuredLocationHint(full);

  let primaryIntent = "general";

  if (hasHybridHint || (hasVehicleSymptom && hasPlaceHint)) {
    primaryIntent = "hybrid";
  } else if (hasPlaceHint) {
    primaryIntent = "places";
  } else if (hasVehicleSymptom || hasPurchaseHint || hasSafetyHint) {
    primaryIntent = "diagnosis";
  }

  const diagnosis =
    primaryIntent === "diagnosis" || primaryIntent === "hybrid";

  const places =
    primaryIntent === "places" || primaryIntent === "hybrid";

  const needsSearch =
    primaryIntent === "places" ||
    primaryIntent === "hybrid" ||
    (hasPurchaseHint && !hasLocationHint) ||
    (hasSafetyHint && places);

  const askForLocation =
    (places || hasPlaceHint) && !hasLocationHint;

  const diagnosisMode = inferDiagnosisMode({
    full,
    detectedCodes,
    hasImageHint,
    hasAudioHint,
    hasPurchaseHint,
    hasSafetyHint,
    hasExplanationHint,
  });

  return {
    primaryIntent,

    diagnosis,
    places,

    purchase: hasPurchaseHint,
    safety: hasSafetyHint,

    image: hasImageHint,
    audio: hasAudioHint,

    explanation_only:
      hasExplanationHint &&
      !hasPlaceHint &&
      !hasHybridHint &&
      !hasPurchaseHint &&
      !hasSafetyHint,

    needsSearch,
    askForLocation,

    hasVehicleSymptom,
    hasLocationHint,

    diagnosisMode,
    detectedCodes,

    languageProfile,

    intentConfidence: scoreIntentConfidence({
      primaryIntent,
      detectedCodes,
      hasVehicleSymptom,
      hasPlaceHint,
      hasHybridHint,
      hasPurchaseHint,
      hasSafetyHint,
      hasImageHint,
      hasAudioHint,
    }),
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\p{L}\p{N}\-\s\.,]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) =>
    text.includes(normalizeText(pattern))
  );
}

function extractFaultCodes(text = "") {
  const matches =
    String(text || "").match(/\b([PCUB][0-9]{3,4}|[A-Z][0-9]{4})\b/gi) || [];

  return [...new Set(matches.map((x) => x.toUpperCase()))].slice(0, 10);
}

function hasStructuredLocationHint(text) {
  const zipLike = /\b\d{5}(?:-\d{4})?\b/;
  const gpsLike = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
  const cityStateLikeLatin = /\b[a-z]{2,}\s*,\s*[a-z]{2,}\b/i;
  const slashArea = /\b[a-z]{2,}\s*\/\s*[a-z]{2,}\b/i;

  return (
    zipLike.test(text) ||
    gpsLike.test(text) ||
    cityStateLikeLatin.test(text) ||
    slashArea.test(text)
  );
}

function detectLanguageProfile(text = "") {
  const raw = String(text || "");

  const hasArabic = /[\u0600-\u06FF]/.test(raw);
  const hasCyrillic = /[\u0400-\u04FF]/.test(raw);
  const hasGreek = /[\u0370-\u03FF]/.test(raw);
  const hasHebrew = /[\u0590-\u05FF]/.test(raw);
  const hasDevanagari = /[\u0900-\u097F]/.test(raw);
  const hasThai = /[\u0E00-\u0E7F]/.test(raw);
  const hasHangul = /[\uAC00-\uD7AF]/.test(raw);
  const hasHiraganaKatakana = /[\u3040-\u30FF]/.test(raw);
  const hasHan = /[\u4E00-\u9FFF]/.test(raw);
  const hasLatin = /[A-Za-z]/.test(raw);

  let script = "unknown";

  if (hasArabic) script = "arabic";
  else if (hasCyrillic) script = "cyrillic";
  else if (hasGreek) script = "greek";
  else if (hasHebrew) script = "hebrew";
  else if (hasDevanagari) script = "devanagari";
  else if (hasThai) script = "thai";
  else if (hasHangul) script = "hangul";
  else if (hasHiraganaKatakana) script = "japanese";
  else if (hasHan) script = "han";
  else if (hasLatin) script = "latin";

  return {
    script,
    mixed_script:
      [hasArabic, hasCyrillic, hasGreek, hasHebrew, hasDevanagari, hasThai, hasHangul, hasHiraganaKatakana, hasHan, hasLatin]
        .filter(Boolean).length > 1,
    reply_same_language: true,
  };
}

function inferDiagnosisMode({
  full = "",
  detectedCodes = [],
  hasImageHint = false,
  hasAudioHint = false,
  hasPurchaseHint = false,
  hasSafetyHint = false,
  hasExplanationHint = false,
}) {
  if (hasPurchaseHint) return "prepurchase";
  if (hasSafetyHint) return "drive_safety";
  if (hasImageHint && detectedCodes.length > 0) return "image_codes_cluster";
  if (hasImageHint) return "image_diagnosis";
  if (hasAudioHint) return "audio_diagnosis";
  if (detectedCodes.length >= 2) return "code_cluster_diagnosis";
  if (detectedCodes.length === 1 && hasExplanationHint) return "single_code_explanation";
  if (detectedCodes.length === 1) return "single_code_diagnosis";
  if (full.includes("dashboard") || full.includes("عداد")) return "dashboard_case";
  return "symptom_diagnosis";
}

function scoreIntentConfidence({
  primaryIntent = "general",
  detectedCodes = [],
  hasVehicleSymptom = false,
  hasPlaceHint = false,
  hasHybridHint = false,
  hasPurchaseHint = false,
  hasSafetyHint = false,
  hasImageHint = false,
  hasAudioHint = false,
}) {
  let score = 0.2;

  if (primaryIntent === "diagnosis") score += 0.2;
  if (primaryIntent === "places") score += 0.2;
  if (primaryIntent === "hybrid") score += 0.3;

  if (detectedCodes.length > 0) score += 0.2;
  if (hasVehicleSymptom) score += 0.15;
  if (hasPlaceHint) score += 0.1;
  if (hasHybridHint) score += 0.1;
  if (hasPurchaseHint) score += 0.1;
  if (hasSafetyHint) score += 0.1;
  if (hasImageHint) score += 0.05;
  if (hasAudioHint) score += 0.05;

  return Math.min(1, Number(score.toFixed(2)));
}
