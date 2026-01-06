import axios from "axios";

/**
* 🌍 Global Local-Expert Search
* Fetches real-world data based on user GPS location.
*/
export async function performSearch(query, user_location = "Global") {
const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) return "Location services are currently offline.";

try {
const params = {
api_key: apiKey,
engine: "google",
// ندمج الموقع المرسل ديناميكياً ليكون البحث عالمياً
q: `${query} near ${user_location}`,
google_domain: "google.com",
gl: "us", // يمكن جعل هذا متغيراً أيضاً حسب الدولة
hl: "en",
num: 4
};

const response = await axios.get("https://serpapi.com/search", { params });
const results = response.data.organic_results || [];

if (results.length === 0) return "No local workshops or parts stores found in this area.";

// تنسيق النتائج ليراها الذكاء الاصطناعي ويحللها للمستخدم
return results.map(r => `• ${r.title}: ${r.link} (Context: ${r.snippet})`).join("\n");
} catch (error) {
console.error("Global Search API Error:", error.message);
return "Local market data currently unavailable.";
}
}
