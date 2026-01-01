// lib/search.js
export async function webSearchSerper(
  query,
  { gl = "us", hl = "en", num = 5 } = {}
) {
  const key = process.env.SERPER_API_KEY;
  if (!key) {
    return { ok: false, error: "NO_SERPER_API_KEY", results: [] };
  }

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, gl, hl, num }),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    return {
      ok: false,
      error: "SERPER_ERROR",
      http: r.status,
      detail: json?.message || JSON.stringify(json).slice(0, 600),
      results: [],
    };
  }

  const organic = Array.isArray(json?.organic) ? json.organic : [];
  const results = organic.slice(0, num).map((x) => ({
    title: x?.title || "",
    link: x?.link || "",
    snippet: x?.snippet || "",
  }));

  return { ok: true, results };
}
