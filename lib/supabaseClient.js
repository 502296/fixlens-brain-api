// lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url =
process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || null;
const key =
process.env.SUPABASE_SERVICE_ROLE_KEY ||
process.env.SUPABASE_ANON_KEY ||
null;

let supabase = null;

if (url && key) {
supabase = createClient(url, key, {
auth: { persistSession: false },
});
}

/**
* إدخال لوج في جدول fixlens_logs
* مطابق للأعمدة اللي عندك بالصورة:
* id, endpoint, mode, input_type, user_lang,
* user_description, ai_response, model, status,
* error_message, latency_ms, meta, created_at
*/
export async function logFixLensEvent(event) {
if (!supabase) return;

try {
await supabase.from("fixlens_logs").insert({
endpoint: event.endpoint || null,
mode: event.mode || null,
input_type: event.inputType || null,
user_lang: event.userLang || null,
user_description: event.userMessage?.slice(0, 4000) || null,
ai_response: event.aiReply?.slice(0, 4000) || null,
model: event.model || event.meta?.model || null,
status: event.status || "success",
error_message: event.errorMessage || null,
latency_ms: event.latencyMs || null,
meta: event.meta || null,
// created_at تنحط أوتوماتيك من الـ default now()
});
} catch (err) {
console.error("Supabase log error:", err.message);
// مهم: لا نرمي الخطأ حتى لا يكسر الـ API
}
}
