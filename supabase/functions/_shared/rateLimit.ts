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
  // during the event is worse than briefly losing the throttle.
  if (error) return false;
  return (count ?? 0) >= MAX_FAILURES_PER_WINDOW;
}

export async function recordAttempt(
  db: SupabaseClient,
  ipHash: string,
  succeeded: boolean,
): Promise<void> {
  await db.from("login_attempts").insert({ ip_hash: ipHash, succeeded });
}
