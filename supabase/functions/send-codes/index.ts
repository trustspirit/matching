import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { timingSafeEqual } from "../_shared/hash.ts";
import { emailEnabled } from "../_shared/sendEmail.ts";
import { bearerToken, verifySession } from "../_shared/session.ts";

/** A row past this many consecutive failures leaves the queue. */
const MAX_ATTEMPTS = 5;

/** Why a run stopped. The admin screen turns each into a different message. */
type Outcome = "done" | "quota" | "time" | "disarmed";

interface RunSummary {
  outcome: Outcome;
  sent: number;
  failed: number;
}

async function config(db: SupabaseClient, key: string): Promise<string | null> {
  const { data, error } = await db
    .from("app_config")
    .select("value")
    .eq("key", key)
    .maybeSingle<{ value: string }>();
  if (error) {
    console.error("app_config read failed", key, error);
    return null;
  }
  return data?.value ?? null;
}

/**
 * The cron job and this function share a secret held in app_config rather than
 * an Edge Function secret: both sides already reach the database, and a value
 * the migration generates is one less thing a deploy can get wrong.
 */
async function isCron(req: Request, db: SupabaseClient): Promise<boolean> {
  const provided = req.headers.get("x-cron-secret") ?? "";
  if (provided === "") return false;
  const expected = await config(db, "cron_secret");
  if (expected === null || expected === "") return false;
  return timingSafeEqual(provided, expected);
}

async function isArmed(db: SupabaseClient): Promise<boolean> {
  // Fail closed: a database fault must not start mailing people.
  return await config(db, "code_send_armed") === "true";
}

async function setArmed(db: SupabaseClient, armed: boolean): Promise<boolean> {
  const { error } = await db
    .from("app_config")
    .update({ value: armed ? "true" : "false" })
    .eq("key", "code_send_armed");
  if (error) {
    console.error("arm write failed", error);
    return false;
  }
  return true;
}

/**
 * How long to stop probing after Brevo says the daily allowance is gone.
 * Brevo does not document its reset hour, so the schedule has to rediscover it
 * -- but re-probing every five minutes for the rest of the day would burn a
 * full participants scan and a wasted API call each time.
 */
const QUOTA_BACKOFF_MS = 30 * 60_000;

/**
 * Written on a 402 and cleared when the queue drains. The cron job reads this
 * in its WHERE clause, so a backoff means the schedule never even starts this
 * function.
 */
async function setRetryAfter(
  db: SupabaseClient,
  at: Date | null,
): Promise<void> {
  const { error } = await db
    .from("app_config")
    .upsert(
      { key: "send_retry_after", value: at === null ? "" : at.toISOString() },
      { onConflict: "key" },
    );
  if (error) console.error("retry_after write failed", error);
}

/**
 * Records where this function answers so the cron job can reach it. A migration
 * cannot invent the project URL, but the platform injects it.
 *
 * Deliberately NOT derived from req.url: that is built from the incoming Host
 * header, so a caller could steer where cron later POSTs the shared secret.
 * SUPABASE_URL is out of the client's reach and this module already reads it
 * through createServiceClient().
 */
async function recordUrl(db: SupabaseClient): Promise<void> {
  const base = Deno.env.get("SUPABASE_URL") ?? "";
  if (base === "") return;
  const value = `${base.replace(/\/+$/, "")}/functions/v1/send-codes`;
  const { error } = await db
    .from("app_config")
    .upsert({ key: "send_codes_url", value }, { onConflict: "key" });
  if (error) console.error("url record failed", error);
}

interface StatusRow {
  email: string | null;
  code_sent_at: string | null;
  send_attempts: number;
}

async function status(db: SupabaseClient): Promise<
  { enabled: boolean; armed: boolean; pending: number; needsAttention: number } | null
> {
  const { data, error } = await db
    .from("participants")
    .select("email, code_sent_at, send_attempts")
    .returns<StatusRow[]>();
  if (error) {
    console.error("status listing failed", error);
    return null;
  }
  const rows = data ?? [];
  const reachable = (r: StatusRow) => r.email !== null && r.email !== "";
  return {
    enabled: emailEnabled(),
    armed: await isArmed(db),
    pending: rows.filter((r) =>
      reachable(r) && r.code_sent_at === null && r.send_attempts < MAX_ATTEMPTS
    ).length,
    needsAttention: rows.filter((r) => r.send_attempts >= MAX_ATTEMPTS).length,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handlePreflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "method_not_allowed" }, 405);
  }

  const db = createServiceClient();

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }
  const action = (payload as { action?: unknown }).action;

  const cron = await isCron(req, db);
  if (!cron) {
    if (!await verifySession(db, bearerToken(req))) {
      return jsonResponse(req, { error: "unauthorized" }, 401);
    }
    // Cheap and idempotent; doing it on every admin call means the URL heals
    // itself if the project is ever moved.
    await recordUrl(db);
  }

  // Cron exists to run the queue and nothing else.
  if (cron && action !== "run") {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  if (action === "status") {
    const result = await status(db);
    if (result === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, result);
  }

  if (action === "arm" || action === "disarm") {
    const armed = action === "arm";
    if (!await setArmed(db, armed)) {
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    return jsonResponse(req, { armed });
  }

  if (action === "run") {
    if (!emailEnabled()) {
      return jsonResponse(req, { error: "email_disabled" }, 400);
    }
    if (!await isArmed(db)) {
      const summary: RunSummary = { outcome: "disarmed", sent: 0, failed: 0 };
      return jsonResponse(req, summary);
    }
    // The loop lands here in the next task.
    const summary: RunSummary = { outcome: "done", sent: 0, failed: 0 };
    return jsonResponse(req, summary);
  }

  return jsonResponse(req, { error: "invalid_request" }, 400);
});
