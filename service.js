import axios from "axios";

/**
* Reliable Local Search Engine
* Linked directly to SERPAPI_KEY.
*/
export async function performSearch(query, user_location = "USA") {
const apiKey = process.env.SERPAPI_KEY;
if (!apiKey) return "Search functionality is offline.";

try {
const params = {
api_key: apiKey,
engine: "google",
q: `${query} in ${user_location}`,
num: 3
};

const response = await axios.get("https://serpapi.com/search", { params });
const results = response.data.organic_results || [];

if (results.length === 0) return "No local services found.";

// Clean formatting for mobile display
return results.map(r => `• ${r.title}: ${r.link}`).join("\n");
} catch (error) {
return "External search service unavailable.";
}
}
