import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { timingSafeEqual } from "../_shared/hash.ts";
import { mintUniqueCode, type TakenCode } from "../_shared/mintCode.ts";
import { emailEnabled, fetchQuota, nextResetAt, sendCodeEmail } from "../_shared/sendEmail.ts";
import { bearerToken, verifySession } from "../_shared/session.ts";

/** A row past this many consecutive failures leaves the queue. */
const MAX_ATTEMPTS = 5;

/**
 * The platform kills a function at 150 seconds of wall clock, and that ceiling
 * includes writing the response. Stopping at 120 leaves room to release claims
 * and report what happened -- a run that dies mid-loop tells the admin nothing.
 */
const TIME_BUDGET_MS = 120_000;

/**
 * An upper bound, not a quota: twenty pending participants yield twenty rows.
 * The loop keeps claiming until the queue empties or the budget runs out, so
 * this only decides how many rows a single hard kill could strand behind a
 * five-minute stale claim. TIME_BUDGET_MS already reserves thirty seconds for
 * release() precisely so that a normal run strands nothing.
 */
const BATCH = 100;

/** The mail is already gone by then, so this write is worth retrying. */
const STAMP_RETRIES = 3;

/** Why a run stopped. The admin screen turns each into a different message. */
type Outcome = "done" | "quota" | "time" | "disarmed" | "partial";

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
 * How long to stop probing after a 402 -- the safety net for when the quota
 * probe (fetchQuota) could not be trusted: a race between the probe and the
 * send, or the probe itself failing to read the account. This is unexpected,
 * so unlike the credits===0 path it does NOT aim at midnight: if the midnight
 * math were ever wrong, a once-a-day probe interval would match the reset
 * interval and stay permanently out of phase, losing a full day each time. An
 * hour always re-syncs within half a day.
 */
const QUOTA_BACKOFF_MS = 60 * 60_000;

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

interface Claimed {
  id: string;
  display_name: string;
  email: string;
}

async function claim(
  db: SupabaseClient,
  runId: string,
): Promise<Claimed[] | null> {
  const { data, error } = await db
    .rpc("claim_pending_codes", { p_run_id: runId, p_limit: BATCH })
    .returns<Claimed[]>();
  if (error) {
    console.error("claim failed", error);
    return null;
  }
  return data ?? [];
}

/**
 * Participants still owed a code, ignoring who currently holds a claim.
 *
 * An empty claim batch is ambiguous: the queue may be empty, or everyone left
 * may be claimed -- by this run's own failures, or by a concurrent run. Only
 * the first case may disarm, so the ambiguity has to be resolved with a real
 * count rather than inferred.
 */
async function pendingCount(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("participants")
    .select("id", { count: "exact", head: true })
    .not("email", "is", null)
    .neq("email", "")
    .is("code_sent_at", null)
    .lt("send_attempts", MAX_ATTEMPTS);
  if (error) {
    console.error("pending count failed", error);
    return null;
  }
  return count ?? 0;
}

/**
 * Every stored code, so a freshly minted one cannot collide. Each row carries
 * its own salt, so uniqueness cannot be a database constraint -- the candidate
 * has to be hashed against every salt. See mintCode.ts.
 */
async function loadTakenCodes(db: SupabaseClient): Promise<TakenCode[] | null> {
  const { data, error } = await db
    .from("participants")
    .select("code_salt, code_hash")
    .returns<{ code_salt: string; code_hash: string }[]>();
  if (error) {
    console.error("taken code listing failed", error);
    return null;
  }
  return (data ?? []).map((r) => ({ salt: r.code_salt, hash: r.code_hash }));
}

/** Hands every row this run still holds back to the queue. */
async function release(db: SupabaseClient, runId: string): Promise<void> {
  const { error } = await db
    .from("participants")
    .update({ send_claim_id: null, send_claimed_at: null })
    .eq("send_claim_id", runId);
  if (error) console.error("claim release failed", error);
}

async function stamp(
  db: SupabaseClient,
  runId: string,
  id: string,
): Promise<void> {
  for (let attempt = 1; attempt <= STAMP_RETRIES; attempt++) {
    const { data, error } = await db
      .from("participants")
      .update({
        code_sent_at: new Date().toISOString(),
        send_claim_id: null,
        send_claimed_at: null,
        send_attempts: 0,
        send_last_error: null,
      })
      .eq("id", id)
      .eq("send_claim_id", runId)
      .select("id");
    if (!error) {
      // Zero rows means the claim moved while the message was in flight: a
      // reissue superseded us. The mail is out but its code is already dead,
      // so the participant will get a fresh one. Nothing to retry -- retrying
      // would only re-check a condition that cannot become true again.
      if ((data ?? []).length === 0) {
        console.warn("send superseded mid-flight", id);
      }
      return;
    }
    console.error(`stamp failed (attempt ${attempt})`, error);
  }
  // The mail cannot be recalled, so this participant will look pending and get
  // a second code on the next run. Say so rather than hiding it.
  await db
    .from("participants")
    .update({ send_last_error: "발송됨, 기록 실패 — 중복 발송 가능" })
    .eq("id", id)
    .eq("send_claim_id", runId);
}

/**
 * Read-modify-write rather than a SQL increment: PostgREST has no atomic
 * increment, and the claim this run still holds means nobody else is touching
 * the row.
 *
 * The claim is deliberately left in place. run()'s finally releases it when
 * the run ends, which is what keeps a transient failure from being retried
 * in a tight loop inside the same run while still returning the participant
 * to the queue for the next one.
 */
async function recordFailure(
  db: SupabaseClient,
  runId: string,
  id: string,
  reason: string,
): Promise<void> {
  const { data } = await db
    .from("participants")
    .select("send_attempts")
    .eq("id", id)
    .maybeSingle<{ send_attempts: number }>();

  const { error } = await db
    .from("participants")
    .update({
      send_attempts: (data?.send_attempts ?? 0) + 1,
      send_last_error: reason.slice(0, 500),
    })
    .eq("id", id)
    .eq("send_claim_id", runId);
  if (error) console.error("failure record failed", error);
}

type OneResult = "sent" | "failed" | "cancelled" | "quota" | "time";

async function sendOne(
  db: SupabaseClient,
  runId: string,
  person: Claimed,
  taken: TakenCode[],
  deadline: number,
): Promise<OneResult> {
  const minted = await mintUniqueCode(taken);
  taken.push({ salt: minted.salt, hash: minted.hash });

  // Guarded by the claim. If anything re-minted this person's code since we
  // claimed them, send_claim_id no longer matches, this writes zero rows, and
  // the send is abandoned -- the newer request wins.
  const { data: written, error: writeError } = await db
    .from("participants")
    .update({
      code_salt: minted.salt,
      code_hash: minted.hash,
      code_sent_at: null,
    })
    .eq("id", person.id)
    .eq("send_claim_id", runId)
    .select("id");
  if (writeError) {
    console.error("code write failed", writeError);
    return "failed";
  }
  if ((written ?? []).length === 0) return "cancelled";

  let result = await sendCodeEmail(person.email, person.display_name, minted.code);

  if (result.kind === "throttled") {
    const waitMs = result.retryAfterSec * 1000;
    // Sleeping past the budget accomplishes nothing: the run would wake with no
    // time left to send. Stop now and let the next cron slot pick this up.
    if (Date.now() + waitMs >= deadline) return "time";
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    result = await sendCodeEmail(person.email, person.display_name, minted.code);
    // Brevo sets the delay, so a second throttle could ask for anything. One
    // retry is the cap; the queue is durable and cron comes back.
    if (result.kind === "throttled") return "time";
  }

  // The daily allowance is gone. This is not the participant's failure, so
  // their attempt counter must not move.
  if (result.kind === "quota") return "quota";

  // emailEnabled() gates the whole run, so this is unreachable in practice.
  if (result.kind === "disabled") return "time";

  if (result.kind === "failed") {
    await recordFailure(db, runId, person.id, result.reason);
    return "failed";
  }

  await stamp(db, runId, person.id);
  return "sent";
}

async function run(db: SupabaseClient): Promise<RunSummary | null> {
  const deadline = Date.now() + TIME_BUDGET_MS;
  const runId = crypto.randomUUID();
  const taken = await loadTakenCodes(db);
  if (taken === null) return null;

  // Ask before spending. Discovering the wall by taking a 402 costs a freshly
  // minted code that then has to be discarded, and it happens once per probe
  // for as long as the allowance stays empty.
  const quota = await fetchQuota();
  if (quota !== null && quota.credits <= 0) {
    // The reset hour is the account's own midnight, which the same response
    // just told us -- so this is a precise appointment, not a poll interval.
    await setRetryAfter(db, nextResetAt(quota.timezone, new Date()));
    return { outcome: "quota", sent: 0, failed: 0 };
  }
  // A null quota means the account could not be read. Fall through and let 402
  // be the signal; refusing to send because a status call failed would be worse.

  let sent = 0;
  let failed = 0;

  try {
    for (;;) {
      if (Date.now() >= deadline) {
        return { outcome: "time", sent, failed };
      }

      const batch = await claim(db, runId);
      if (batch === null) return null;
      if (batch.length === 0) {
        const remaining = await pendingCount(db);
        if (remaining === null) return null;
        if (remaining > 0) {
          // Someone is still owed a code but is claimed right now -- this
          // run's own failure (recordFailure deliberately leaves the claim in
          // place), or a concurrent run. Stay armed; the next tick gets them.
          return { outcome: "partial", sent, failed };
        }
        // The queue is genuinely empty. Disarm so the next CSV import cannot
        // start mailing people before anyone has looked at it, and drop any
        // quota backoff so a stale timestamp cannot delay the next event's
        // first run.
        await setArmed(db, false);
        await setRetryAfter(db, null);
        return { outcome: "done", sent, failed };
      }

      for (const person of batch) {
        if (Date.now() >= deadline) {
          await release(db, runId);
          return { outcome: "time", sent, failed };
        }
        const result = await sendOne(db, runId, person, taken, deadline);
        if (result === "sent") {
          sent++;
        } else if (result === "failed") {
          failed++;
        } else if (result === "quota") {
          await release(db, runId);
          // Stay armed -- the job is not finished, it is waiting for tomorrow.
          // Only an empty queue disarms. The backoff is what keeps the schedule
          // from re-probing every five minutes until Brevo's counter resets.
          await setRetryAfter(db, new Date(Date.now() + QUOTA_BACKOFF_MS));
          return { outcome: "quota", sent, failed };
        } else if (result === "time") {
          await release(db, runId);
          return { outcome: "time", sent, failed };
        }
        // "cancelled" is neither: nothing was sent and nothing went wrong.
      }
    }
  } finally {
    // Every exit -- normal, early, or thrown -- hands back whatever this run
    // still holds. A leaked claim hides that participant from the queue for
    // the full five-minute stale window, and later tasks add more exits.
    await release(db, runId);
  }
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
    const summary = await run(db);
    if (summary === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, summary);
  }

  return jsonResponse(req, { error: "invalid_request" }, 400);
});
