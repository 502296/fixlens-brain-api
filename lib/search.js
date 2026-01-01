export async function webSearchSerper(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { ok: false, results: [] };

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query, gl: "us", hl: "en", num: 5 })
  });

  const data = await r.json();
  return {
    ok: true,
    results: data.organic || []
  };
}
