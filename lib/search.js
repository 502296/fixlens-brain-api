import axios from "axios";

// قمنا بتغيير الاسم ليتطابق مع الاستدعاء في service.js وإضافة الموقع
export async function performSearch(query, user_location = "USA") {
const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) return "Search engine offline.";

try {
const params = {
api_key: apiKey,
engine: "google",
// ندمج الموقع مع نص البحث لضمان نتائج محلية دقيقة
q: `${query} near ${user_location}`,
num: 3
};

const response = await axios.get("https://serpapi.com/search", { params });
const results = response.data.organic_results || [];
// تحويل النتائج لنص مفهوم للذكاء الاصطناعي
return results.map(r => `${r.title}: ${r.link} (Description: ${r.snippet})`).join("\n");
} catch (error) {
return "External search unavailable.";
}
}
