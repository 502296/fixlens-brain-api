// lib/logs.js
import { supabaseAdmin } from "./db.js";

/**
* حفظ Log ناجح أو فيه تحذير
*/
export async function saveLog({
endpoint,
mode,
inputType,
userLang,
userDescription,
aiResponse,
model,
status = "success",
errorMessage = null,
latencyMs = null,
meta = null,
}) {
try {
const { error } = await supabaseAdmin.from("fixlens_logs").insert({
endpoint,
mode,
input_type: inputType || null,
user_lang: userLang || null,
user_description: userDescription || null,
ai_response: aiResponse || null,
model: model || null,
status,
error_message: errorMessage,
latency_ms: latencyMs,
meta,
});

if (error) {
console.error("[saveLog] Supabase error:", error);
}
} catch (err) {
console.error("[saveLog] Unexpected error:", err);
}
}

/**
* حفظ Log خاص بالأخطاء القوية
*/
export async function logError({ endpoint, error, payload }) {
try {
const { error: supabaseError } = await supabaseAdmin
.from("fixlens_errors")
.insert({
endpoint,
error_message: error?.message || String(error),
stack: error?.stack || null,
payload: payload ? payload : null,
});

if (supabaseError) {
console.error("[logError] Supabase error:", supabaseError);
}
} catch (err) {
console.error("[logError] Unexpected error:", err);
}
}

/**
* حفظ ذاكرة بسيطة ليستفيد منها FixLens لاحقاً
*/
export async function saveMemory({ userId, key, content, importance = 1 }) {
try {
const { error } = await supabaseAdmin.from("fixlens_memory").insert({
user_id: userId || null,
key: key || null,
content,
importance,
});

if (error) {
console.error("[saveMemory] Supabase error:", error);
}
} catch (err) {
console.error("[saveMemory] Unexpected error:", err);
}
}
