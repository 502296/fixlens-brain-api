// intentDetector.js
// English-only intent heuristics
// One global logic layer, no language-specific branches

export function detectIntent({
  text = "",
  history = [],
  location = null
} = {}) {
  const t = normalizeText(text);
  const recentHistory = normalizeText(
    history
      .slice(-4)
      .map((item) => {
        if (typeof item?.content === "string") {
          return item.content;
        }
        return JSON.stringify(item?.content || "");
      })
      .join(" ")
  );

  const full = `${t} ${recentHistory}`.trim();

  const symptomPatterns = [
    "noise",
    "knock",
    "tick",
    "rattle",
    "shake",
    "vibration",
    "misfire",
    "smoke",
    "leak",
    "overheat",
    "stall",
    "hesitation",
    "rough idle",
    "hard start",
    "no start",
    "check engine",
    "transmission",
    "brake",
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
    "p030",
    "p0420",
    "p0171"
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
    "open now"
  ];

  const hybridPatterns = [
    "where should i take it",
    "can i drive it to a shop",
    "what shop should i go to",
    "find me a mechanic",
    "who can fix this"
  ];

  const hasVehicleSymptom = containsAny(full, symptomPatterns);
  const hasPlaceHint = containsAny(full, placePatterns);
  const hasHybridHint = containsAny(full, hybridPatterns);
  const hasLocationHint = Boolean(location) || hasStructuredLocationHint(full);

  let primaryIntent = "general";

  if (hasHybridHint || (hasVehicleSymptom && hasPlaceHint)) {
    primaryIntent = "hybrid";
  } else if (hasPlaceHint) {
    primaryIntent = "places";
  } else if (hasVehicleSymptom) {
    primaryIntent = "diagnosis";
  }

  const needsSearch =
    primaryIntent === "places" ||
    primaryIntent === "hybrid";

  const askForLocation =
    needsSearch && !hasLocationHint;

  return {
    primaryIntent,
    diagnosis:
      primaryIntent === "diagnosis" ||
      primaryIntent === "hybrid",
    places:
      primaryIntent === "places" ||
      primaryIntent === "hybrid",
    needsSearch,
    askForLocation,
    hasVehicleSymptom,
    hasLocationHint
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function hasStructuredLocationHint(text) {
  const zipLike = /\b\d{5}(?:-\d{4})?\b/;
  const gpsLike = /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/;
  const cityStateLike = /\b[a-z]{2,}\s*,\s*[a-z]{2,}\b/;

  return (
    zipLike.test(text) ||
    gpsLike.test(text) ||
    cityStateLike.test(text)
  );
}
