// engineIntel.js

export function buildEnginePack(text="") {

  const t = text.toLowerCase();

  let make=null;
  let model=null;
  let year=null;

  const yearMatch =
    t.match(/\b(19|20)\d{2}\b/);

  if(yearMatch)
    year = Number(yearMatch[0]);

  if(t.includes("toyota"))
    make="Toyota";

  if(t.includes("camry"))
    model="Camry";

  return {

    make,
    model,
    year,

    detected_engine:null,

    intel_score:0

  };
}
