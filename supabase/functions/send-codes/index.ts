import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { timingSafeEqual } from "../_shared/hash.ts";
import {
  emailEnabled,
  fetchQuota,
  nextResetAt,
  sendCodeEmail,
  senderIsValidated,
} from "../_shared/sendEmail.ts";
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

/**
 * Why a run stopped. The admin screen turns each into a different message.
 *
 * "blocked" is distinct from "done": both disarm because cron cannot make
 * further progress, but "done" means everyone reachable has a code, while
 * "blocked" means one or more participants are stuck at MAX_ATTEMPTS and
 * still have no code -- a human has to fix an address or reissue a code
 * before that row is reachable again. Collapsing the two would make an outage
 * that ran every row to the ceiling look identical to a clean finish.
 *
 * "sender" is the configuration equivalent: nothing was attempted because the
 * From address is not one Brevo will accept, which no amount of retrying
 * fixes.
 */
type Outcome =
  | "done"
  | "quota"
  | "time"
  | "disarmed"
  | "partial"
  | "blocked"
  | "sender";

interface RunSummary {
  outcome: Outcome;
  sent: number;
  failed: number;
  /**
   * Reachable, still-uncoded participants parked at MAX_ATTEMPTS. Only
   * populated (non-zero) on the "blocked" outcome; every other outcome
   * reports 0 without spending a query on it.
   */
  blocked: number;
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
  display_name: string;
  email: string | null;
  code_sent_at: string | null;
  send_attempts: number;
  send_last_error: string | null;
}

interface AttentionRow {
  displayName: string;
  error: string | null;
}

/**
 * How many needing-attention rows to name in the status response.
 * send_last_error was previously written and never read anywhere -- an admin
 * facing a rotated API key and a typo'd address saw the identical "확인 필요"
 * count for both. This is capped so the response stays small even with the
 * whole ~350-participant list past the ceiling at once; the count above it
 * (needsAttention) is exact, only the sample is capped.
 */
const ATTENTION_SAMPLE_LIMIT = 10;

async function status(db: SupabaseClient): Promise<
  {
    enabled: boolean;
    armed: boolean;
    pending: number;
    needsAttention: number;
    needsAttentionSample: AttentionRow[];
  } | null
> {
  const { data, error } = await db
    .from("participants")
    .select("display_name, email, code_sent_at, send_attempts, send_last_error")
    .returns<StatusRow[]>();
  if (error) {
    console.error("status listing failed", error);
    return null;
  }
  const rows = data ?? [];
  const reachable = (r: StatusRow) => r.email !== null && r.email !== "";
  const attention = rows.filter((r) => r.send_attempts >= MAX_ATTEMPTS);
  return {
    enabled: emailEnabled(),
    armed: await isArmed(db),
    pending: rows.filter((r) =>
      reachable(r) && r.code_sent_at === null && r.send_attempts < MAX_ATTEMPTS
    ).length,
    needsAttention: attention.length,
    needsAttentionSample: attention
      .slice(0, ATTENTION_SAMPLE_LIMIT)
      .map((r) => ({ displayName: r.display_name, error: r.send_last_error })),
  };
}

interface Claimed {
  id: string;
  display_name: string;
  email: string;
  code: string;
}

async function claim(
  db: SupabaseClient,
  runId: string,
): Promise<Claimed[] | null> {
  const { data, error } = await db
    .rpc("claim_pending_codes", {
      p_run_id: runId,
      p_limit: BATCH,
      // The single source of truth for the ceiling. See L2 in the whole-branch
      // review: the RPC used to hardcode its own "5", and the two could drift.
      p_max_attempts: MAX_ATTEMPTS,
    })
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
 * Reachable participants stuck at the attempt ceiling with no code yet.
 *
 * An empty claim batch with pendingCount() also at 0 is still ambiguous: the
 * queue may be genuinely empty, or every remaining row may have been driven
 * to MAX_ATTEMPTS by an outage (F1). Only the former may report "done" and
 * let the admin believe everyone was mailed; the latter must say so.
 */
async function blockedCount(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("participants")
    .select("id", { count: "exact", head: true })
    .not("email", "is", null)
    .neq("email", "")
    .is("code_sent_at", null)
    .gte("send_attempts", MAX_ATTEMPTS);
  if (error) {
    console.error("blocked count failed", error);
    return null;
  }
  return count ?? 0;
}

/** Hands every row this run still holds back to the queue. */
async function release(db: SupabaseClient, runId: string): Promise<void> {
  const { error } = await db
    .from("participants")
    .update({ send_claim_id: null, send_claimed_at: null })
    .eq("send_claim_id", runId);
  if (error) console.error("claim release failed", error);
}

/**
 * Backoff between stamp() retries, indexed by attempt number (1-based) --
 * BACKOFF_MS[attempt] is the wait AFTER that attempt fails. A short outage of
 * a few hundred milliseconds otherwise fails all STAMP_RETRIES attempts
 * inside the same window, since back-to-back retries with no delay are not
 * independent trials. No entry for the last attempt: there is nothing left to
 * wait for.
 */
const STAMP_BACKOFF_MS = [200, 400];

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
    if (attempt < STAMP_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, STAMP_BACKOFF_MS[attempt - 1]));
    }
  }
  // The mail cannot be recalled, so this participant will look pending and get
  // a second code on the next run. Say so rather than hiding it.
  const { error: markerError } = await db
    .from("participants")
    .update({ send_last_error: "발송됨, 기록 실패 — 중복 발송 가능" })
    .eq("id", id)
    .eq("send_claim_id", runId);
  if (markerError) {
    // Every write around this send has now failed. The row is left with
    // code_sent_at null, send_last_error null and the claim released --
    // indistinguishable from a participant who was never touched, so the next
    // run mails them again with no trace of this having happened. This is the
    // one case nothing downstream can recover from; it must be loud.
    console.error(
      "stamp marker write also failed -- participant now looks untouched and WILL be mailed a duplicate code",
      id,
      markerError,
    );
  }
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

type OneResult = "sent" | "failed" | "quota" | "time";

/**
 * Mails a participant the code the row already holds.
 *
 * This used to mint a new code and write it before sending, because the
 * server kept only a digest and so could not name the code it had issued. The
 * cost was that a rejected send left the participant holding a code nobody
 * could name: the old one was already overwritten, and the new one existed
 * only in a message that never arrived. Sending the stored code makes a
 * failure cost nothing but a retry.
 */
async function sendOne(
  db: SupabaseClient,
  runId: string,
  person: Claimed,
  deadline: number,
): Promise<OneResult> {
  let result = await sendCodeEmail(person.email, person.display_name, person.code);

  if (result.kind === "throttled") {
    const waitMs = result.retryAfterSec * 1000;
    // Sleeping past the budget accomplishes nothing: the run would wake with no
    // time left to send. Stop now and let the next cron slot pick this up.
    if (Date.now() + waitMs >= deadline) return "time";
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    result = await sendCodeEmail(person.email, person.display_name, person.code);
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

  // Brevo accepts a message from an unvalidated sender with a 201 and then
  // discards it at the relay, so nothing in the send path can tell that the
  // mail died. Left unchecked, a whole run reports success while every
  // participant gets nothing. One request up front closes that gap.
  if (await senderIsValidated() === false) {
    return { outcome: "sender", sent: 0, failed: 0, blocked: 0 };
  }

  // Ask before spending. Taking a 402 to discover the wall costs a round trip
  // per participant for as long as the allowance stays empty.
  const quota = await fetchQuota();
  if (quota !== null && quota.credits <= 0) {
    // The reset hour is the account's own midnight, which the same response
    // just told us -- so this is a precise appointment, not a poll interval.
    await setRetryAfter(db, nextResetAt(quota.timezone, new Date()));
    return { outcome: "quota", sent: 0, failed: 0, blocked: 0 };
  }
  // A null quota means the account could not be read. Fall through and let 402
  // be the signal; refusing to send because a status call failed would be worse.

  let sent = 0;
  let failed = 0;

  try {
    for (;;) {
      if (Date.now() >= deadline) {
        return { outcome: "time", sent, failed, blocked: 0 };
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
          return { outcome: "partial", sent, failed, blocked: 0 };
        }
        // pendingCount is 0, but that is still ambiguous (F1): it is true both
        // when the queue is genuinely empty AND when every remaining reachable
        // participant has been driven to MAX_ATTEMPTS by an outage. Only the
        // former may report "done" -- the admin must be told the truth in the
        // latter case rather than seeing a false "전원 발송을 마쳤습니다".
        const blocked = await blockedCount(db);
        if (blocked === null) return null;
        if (blocked > 0) {
          // Cron cannot make progress on ceiling-blocked rows: only a human
          // editing an address or reissuing a code resets send_attempts and
          // lets the row back into claim_pending_codes' WHERE clause. Disarm
          // exactly as "done" does, since staying armed would just re-run
          // this same empty batch every five minutes -- but report the count
          // so the UI can say what actually happened.
          await setArmed(db, false);
          await setRetryAfter(db, null);
          return { outcome: "blocked", sent, failed, blocked };
        }
        // The queue is genuinely empty. Disarm so the next CSV import cannot
        // start mailing people before anyone has looked at it, and drop any
        // quota backoff so a stale timestamp cannot delay the next event's
        // first run.
        await setArmed(db, false);
        await setRetryAfter(db, null);
        return { outcome: "done", sent, failed, blocked: 0 };
      }

      for (const person of batch) {
        if (Date.now() >= deadline) {
          await release(db, runId);
          return { outcome: "time", sent, failed, blocked: 0 };
        }
        const result = await sendOne(db, runId, person, deadline);
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
          return { outcome: "quota", sent, failed, blocked: 0 };
        } else if (result === "time") {
          await release(db, runId);
          return { outcome: "time", sent, failed, blocked: 0 };
        }
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
      const summary: RunSummary = { outcome: "disarmed", sent: 0, failed: 0, blocked: 0 };
      return jsonResponse(req, summary);
    }
    const summary = await run(db);
    if (summary === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, summary);
  }

  return jsonResponse(req, { error: "invalid_request" }, 400);
});
