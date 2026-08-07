import type { SupabaseClient } from "@supabase/supabase-js";
import { hashHex } from "./hash.ts";

const WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

export function clientIp(req: Request): string {
  // Supabase sits behind a proxy, so the socket address is useless here.
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

/** Hashed with a server-side salt so raw addresses are never persisted. */
export function hashIp(ip: string): Promise<string> {
  return hashHex(ip + (Deno.env.get("IP_HASH_SALT") ?? ""));
}

export async function isRateLimited(
  db: SupabaseClient,
  ipHash: string,
): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await db
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .eq("succeeded", false)
    .gte("attempted_at", since);

  // Fail open on a counting error: locking every participant out of the site
  // during the event is worse than briefly losing the throttle. Still log it
  // so an operator can notice the throttle degraded (checked against Supabase's
  // function logs) rather than have it fail silently.
  if (error) {
    console.error("rate limit check failed, failing open", error);
    return false;
  }
  return (count ?? 0) >= MAX_FAILURES_PER_WINDOW;
}

export async function recordAttempt(
  db: SupabaseClient,
  ipHash: string,
  succeeded: boolean,
): Promise<void> {
  const { error } = await db
    .from("login_attempts")
    .insert({ ip_hash: ipHash, succeeded });
  // Log-only: a failed insert should not block the caller's response, but it
  // should be visible in the function logs so an operator can investigate.
  if (error) console.error("failed to record login attempt", error);
}
