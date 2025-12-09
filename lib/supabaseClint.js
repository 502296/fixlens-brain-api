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
* إدخال لوج بسيط في Supabase لكن بدون ما نكسر الرد لو صار خطأ.
*/
export async function logFixLensEvent(event) {
if (!supabase) return; // إذا مو مضبوط، نتجاهله تمامًا

try {
await supabase.from("fixlens_logs").insert({
created_at: new Date().toISOString(),
source: event.source || "mobile-app",
mode: event.mode || "text",
user_message: event.userMessage?.slice(0, 4000) || null,
ai_reply: event.aiReply?.slice(0, 4000) || null,
meta: event.meta || null,
});
} catch (err) {
console.error("Supabase log error:", err.message);
// مهم: لا نرمي الخطأ، حتى لا يرجع 500 للمستخدم
}
}
