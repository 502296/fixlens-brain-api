import axios from "axios";

export async function webSearch(query, locale = "en") {
const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) return { ok: false, results: [] };

// استخراج الدولة من الـ locale (مثلاً ar-IQ تعني العراق)
const countryCode = locale.includes("-") ? locale.split("-")[1].toLowerCase() : "us";

try {
const params = {
api_key: apiKey,
engine: "google",
q: query,
hl: locale.split("-")[0], // اللغة
gl: countryCode, // الدولة للنتائج المحلية
num: 3 // 3 نتائج كافية لتقليل التكلفة
};

const response = await axios.get("https://serpapi.com/search", { params });
return { ok: true, results: response.data.organic_results || [] };
} catch (error) {
return { ok: false, results: [] };
}
}
