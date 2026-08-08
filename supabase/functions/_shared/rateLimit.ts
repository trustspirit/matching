import type { SupabaseClient } from "@supabase/supabase-js";
import { hashHex } from "./hash.ts";

const WINDOW_MS = 60_000;
// Keyed on IP alone, and the event's ~350 participants can share one egress
// address (venue Wi-Fi, carrier CGNAT) while all logging in within minutes of
// each other. A low threshold throttles the whole crowd on a handful of
// unrelated mistyped codes, not just an attacker. This number isn't the
// system's real defense against brute-forcing a code -- the 30-character,
// 6-length alphabet (~7.29e8 combinations) and the per-candidate timing
// equalization in hash.ts are -- so it only needs to be high enough to blunt
// scripted abuse, not low enough to meaningfully slow a targeted guesser.
const MAX_FAILURES_PER_WINDOW = 30;

export function clientIp(req: Request): string {
  // Supabase sits behind a proxy, so the socket address is useless here.
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || "unknown";
}

const SALT_KEY = "ip_hash_salt";

/**
 * Cached across requests within a worker. Only a successful read is cached, so
 * a transient DB fault does not poison the worker for its whole lifetime.
 */
let cachedSalt: string | null = null;

/**
 * Reads the server-generated IP hash salt. Returns null when it cannot be
 * read; callers must then skip rate limiting entirely rather than hashing
 * unsalted -- the IPv4 space is small enough to reverse without a salt, and a
 * different hash space would not match previously recorded rows anyway.
 */
export async function getIpSalt(db: SupabaseClient): Promise<string | null> {
  if (cachedSalt !== null) return cachedSalt;

  const { data, error } = await db
    .from("app_config")
    .select("value")
    .eq("key", SALT_KEY)
    .maybeSingle<{ value: string }>();

  if (error || !data) {
    console.error("ip hash salt unavailable, skipping rate limit", error);
    return null;
  }
  cachedSalt = data.value;
  return cachedSalt;
}

/** Hashed with a server-side salt so raw addresses are never persisted. */
export function hashIp(ip: string, salt: string): Promise<string> {
  return hashHex(ip + salt);
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
