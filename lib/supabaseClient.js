// lib/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

const url =
process.env.NEXT_PUBLIC_SUPABASE_URL ||
process.env.SUPABASE_URL ||
null;

const key =
process.env.SUPABASE_SERVICE_ROLE_KEY ||
process.env.SUPABASE_ANON_KEY ||
null;

let supabase = null;

if (url && key) {
supabase = createClient(url, key, {
auth: { persistSession: false },
});
} else {
console.warn(
"[supabaseClient] Supabase URL or KEY is missing. Logging will be disabled."
);
}

/**
* إدخال لوج بسيط في Supabase لكن بدون ما نكسر الرد لو صار خطأ.
*
* الشكل المتوقَّع لـ event:
* {
* source?: "mobile-app" | "web" | ...,
* endpoint?: "/api/diagnose",
* mode?: "text" | "image" | "audio",
* inputType?: "text" | "image" | "audio",
* userLang?: string,
* userMessage?: string,
* aiReply?: string,
* status?: "success" | "error",
* errorMessage?: string,
* latencyMs?: number,
* meta?: object
* }
*/
export async function logFixLensEvent(event) {
if (!supabase) return; // إذا مو مضبوط، نتجاهله تمامًا

try {
const payload = {
endpoint: event.endpoint || "/api/diagnose",
mode: event.mode || "text",
input_type: event.inputType || event.mode || "text",
user_lang:
event.userLang ||
(event.meta && event.meta.targetLanguage) ||
null,
user_description: event.userMessage
? event.userMessage.slice(0, 4000)
: null,
ai_response: event.aiReply ? event.aiReply.slice(0, 4000) : null,
model: event.meta?.model || null,
status: event.status || "success",
error_message: event.errorMessage || null,
latency_ms: event.latencyMs || null,
meta: {
// نخزن السورس داخل الميتا
source: event.source || "mobile-app",
...(event.meta || {}),
},
// created_at لا نرسله، يجي من الـ default now()
};

await supabase.from("fixlens_logs").insert(payload);
} catch (err) {
console.error("[supabaseClient] Supabase log error:", err.message);
// مهم: لا نرمي الخطأ، حتى لا يرجع 500 للمستخدم
}
}
