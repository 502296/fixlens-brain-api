import axios from "axios";

export async function performSearch(query, user_location = "Global") {
const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) return "Search engine offline.";

try {
const params = {
api_key: apiKey,
engine: "google",
q: `${query} near ${user_location}`,
num: 4
};

const response = await axios.get("https://serpapi.com/search", { params });
const results = response.data.organic_results || [];

if (results.length === 0) return "No local data found.";

return results.map(r => `• ${r.title}: ${r.link} (Note: ${r.snippet})`).join("\n");
} catch (error) {
return "Local market data unavailable.";
}
}
