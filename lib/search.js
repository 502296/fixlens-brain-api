import axios from "axios";

export async function webSearch(query, options = {}) {
const apiKey = process.env.SERPAPI_KEY; // تأكد من وجود هذا المفتاح في Railway
if (!apiKey) {
console.warn("⚠️ SERPAPI_KEY missing");
return { ok: false, results: [] };
}

try {
// تحديد اللغة (hl) والبلد (gl) بناءً على المدخلات لجعل النتائج محليّة ودقيقة
const params = {
api_key: apiKey,
engine: "google",
q: query,
google_domain: "google.com",
hl: options.hl || "en", // اللغة: ar للعربي، en للإنجليزي، إلخ
gl: options.gl || "us", // الموقع: مثلاً iq للعراق، us لأمريكا
num: 5,
};

const response = await axios.get("https://serpapi.com/search", { params });

const results = (response.data.organic_results || []).map(r => ({
title: r.title,
snippet: r.snippet,
link: r.link
}));

return { ok: true, results };
} catch (error) {
console.error("Web Search Error:", error.message);
return { ok: false, results: [] };
}
}
