// service.js (Partial update for clarity)
// ... (imports remain the same)

export async function handleFixLensRequest(req) {
try {
let {
text = "",
locale = "auto",
image_base64,
audio_base64,
history = [],
user_location = "USA" // Default to USA for your current context
} = req.body;

// 1. Audio Processing (Whisper)
if (audio_base64) {
const voiceText = await transcribeAudio(audio_base64);
// We append voice text to the main query for analysis
if (voiceText) text = `${text} ${voiceText}`.trim();
}

// 2. Local Search Logic
let searchResults = "";
// Trigger search for shops or parts automatically
const searchKeywords = ["shop", "workshop", "parts", "repair", "محل", "ورشة", "تصليح"];
const needsSearch = searchKeywords.some(keyword => text.toLowerCase().includes(keyword));

if (needsSearch) {
searchResults = await performSearch(text, user_location);
}

// 3. Optimized Final Context (Cleaner)
const finalContext = `
User Location: ${user_location}
User Query: ${text}

Technical Data: ${buildKnowledgeSnippets(text)}
Nearby Services: ${searchResults}
`;

// 4. Send to GPT-4o
if (image_base64) {
return await analyzeWithVision(finalContext, locale, image_base64, history);
}
return await analyzeWithText(finalContext, locale, history);

} catch (error) {
console.error("FixLens Service Error:", error);
throw error;
}
}
