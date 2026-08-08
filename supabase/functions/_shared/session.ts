import type { SupabaseClient } from "@supabase/supabase-js";
import { hashHex } from "./hash.ts";

/** Long enough that guessing is not a threat model. */
const TOKEN_BYTES = 32;

/**
 * Twelve hours covers an event evening without leaving a session open
 * indefinitely on a shared machine.
 */
const SESSION_HOURS = 12;

export function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function randomToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mints a session and returns the plaintext token. Only its hash is stored, so
 * this return value is the only copy that ever exists.
 */
export async function issueSession(db: SupabaseClient): Promise<string | null> {
  // Opportunistic cleanup: expired rows would otherwise accumulate forever and
  // there is no scheduler in this project.
  const { error: sweepError } = await db
    .from("admin_sessions")
    .delete()
    .lt("expires_at", new Date().toISOString());
  if (sweepError) console.error("session sweep failed", sweepError);

  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600_000);

  const { error } = await db.from("admin_sessions").insert({
    token_hash: await hashHex(token),
    expires_at: expiresAt.toISOString(),
  });
  if (error) {
    console.error("session insert failed", error);
    return null;
  }
  return token;
}

export async function verifySession(
  db: SupabaseClient,
  token: string,
): Promise<boolean> {
  if (token === "") return false;
  const { data, error } = await db
    .from("admin_sessions")
    .select("token_hash")
    .eq("token_hash", await hashHex(token))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<{ token_hash: string }>();

  if (error) {
    // Fail closed. Unlike the participant rate limiter, refusing here only
    // costs the admin a re-login, while accepting on a DB fault would let an
    // arbitrary token through.
    console.error("session verify failed", error);
    return false;
  }
  return data !== null;
}

export async function revokeSession(
  db: SupabaseClient,
  token: string,
): Promise<void> {
  if (token === "") return;
  const { error } = await db
    .from("admin_sessions")
    .delete()
    .eq("token_hash", await hashHex(token));
  if (error) console.error("session revoke failed", error);
}
