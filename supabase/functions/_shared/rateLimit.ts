import type { SupabaseClient } from "@supabase/supabase-js";
import { hashHex } from "./hash.ts";

export interface RateLimitPolicy {
  readonly table: string;
  readonly windowMs: number;
  readonly maxFailures: number;
  /**
   * login_attempts stores both outcomes, so counting failures must exclude
   * successes. admin_attempts stores failures only and has no such column.
   */
  readonly succeededColumn: string | null;
}

// Keyed on IP alone, and the event's ~350 participants can share one egress
// address (venue Wi-Fi, carrier CGNAT) while all logging in within minutes of
// each other. A low threshold throttles the whole crowd on a handful of
// unrelated mistyped codes, not just an attacker. This number isn't the
// system's real defense against brute-forcing a code -- the 30-character,
// 6-length alphabet (~7.29e8 combinations) and the per-candidate timing
// equalization in hash.ts are -- so it only needs to be high enough to blunt
// scripted abuse, not low enough to meaningfully slow a targeted guesser.
export const PARTICIPANT_POLICY: RateLimitPolicy = {
  table: "login_attempts",
  windowMs: 60_000,
  maxFailures: 30,
  succeededColumn: "succeeded",
};

// The admin is exactly one person, so this can be strict. It exists to offset
// the brute-force surface added by admin-import's verifyOnly branch.
export const ADMIN_POLICY: RateLimitPolicy = {
  table: "admin_attempts",
  windowMs: 900_000,
  maxFailures: 10,
  succeededColumn: null,
};

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
  policy: RateLimitPolicy,
): Promise<boolean> {
  const since = new Date(Date.now() - policy.windowMs).toISOString();
  let query = db
    .from(policy.table)
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("attempted_at", since);
  if (policy.succeededColumn !== null) {
    query = query.eq(policy.succeededColumn, false);
  }
  const { count, error } = await query;

  // Fail open on a counting error: locking every participant out of the site
  // during the event is worse than briefly losing the throttle. For the admin
  // path the same reasoning applies more sharply -- if the organizer cannot
  // upload the CSV there is no matching data and the event cannot run. Still
  // log it so an operator can notice the throttle degraded (checked against
  // Supabase's function logs) rather than have it fail silently.
  if (error) {
    console.error("rate limit check failed, failing open", error);
    return false;
  }
  return (count ?? 0) >= policy.maxFailures;
}

export async function recordAttempt(
  db: SupabaseClient,
  ipHash: string,
  succeeded: boolean,
  policy: RateLimitPolicy,
): Promise<void> {
  // A table without a succeeded column only ever stores failures.
  if (policy.succeededColumn === null && succeeded) return;

  const row: Record<string, unknown> = { ip_hash: ipHash };
  if (policy.succeededColumn !== null) row[policy.succeededColumn] = succeeded;

  const { error } = await db.from(policy.table).insert(row);
  // Log-only: a failed insert should not block the caller's response, but it
  // should be visible in the function logs so an operator can investigate.
  if (error) console.error("failed to record login attempt", error);
}
