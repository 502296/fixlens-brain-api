// intentDetector.js

export function detectIntent({ text = "", history = [] }) {

  const t = text.toLowerCase();

  const diagnosisWords = [
    "noise","knock","misfire",
    "engine","smoke",
    "صوت","دخان","تقطيع"
  ];

  const placeWords = [
    "near me",
    "mechanic",
    "repair shop",
    "ورشة",
    "ميكانيكي"
  ];

  const diagnosis =
    diagnosisWords.some(w =>
      t.includes(w)
    );

  const places =
    placeWords.some(w =>
      t.includes(w)
    );

  return {

    diagnosis,

    places,

    needsSearch:
      places

  };
}
