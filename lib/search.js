export async function webSearchSerper(query, { gl = "us", hl = "en", num = 5 } = {}) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: false, error: "NO_SERPER_API_KEY", results: [] };

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, gl, hl, num }),
  });

  if (!r.ok) {
    return { ok: false, error: `SERPER_HTTP_${r.status}`, results: [] };
  }

  const data = await r.json();
  const items = Array.isArray(data?.organic) ? data.organic : [];

  const results = items.slice(0, num).map((it) => ({
    title: it.title || "",
    link: it.link || "",
    snippet: it.snippet || "",
  }));

  return { ok: true, results };
}

// ✅ IMPORTANT: provide the export your service expects
export async function webSearch(query, opts) {
  return webSearchSerper(query, opts);
}
