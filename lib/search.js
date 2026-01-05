// lib/search.js

import fetch from "node-fetch";

export async function webSearch(query) {
  if (!query || query.length < 6) return "";

  // 🔒 FixLens search is INTERNAL ONLY (silent brain)
  // You can later swap this with Serper / Tavily / Bing

  try {
    // Placeholder smart search notes (safe + cheap)
    return `
Internal search notes:
- Similar issues commonly reported with electrical load or transmission sensors.
- Known pattern: voltage drop after battery replacement.
- Weather / vibration can worsen connector issues.
`;
  } catch (err) {
    console.error("webSearch error:", err);
    return "";
  }
}
