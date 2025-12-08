// lib/db.js
// Supabase admin client (server-side only)

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
throw new Error(
"Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables."
);
}

// هذا الكلاينت لا يُستخدم أبداً في التطبيق، فقط في الـ API
export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
auth: {
persistSession: false,
},
});
