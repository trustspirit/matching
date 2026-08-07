import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role client. This key bypasses RLS, so it must never leave the
 * Edge Function process.
 */
export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
