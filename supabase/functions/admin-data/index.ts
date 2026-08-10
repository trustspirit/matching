import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { hashCode, timingSafeEqual } from "../_shared/hash.ts";
import { mintUniqueCode, type TakenCode } from "../_shared/mintCode.ts";
import { buildCodesCsv } from "../_shared/lib/csv.ts";
import { sendCodeEmail } from "../_shared/sendEmail.ts";
import { normalizeName } from "../_shared/lib/name.ts";
import { isValidCode, normalizeCode } from "../_shared/lib/code.ts";
import {
  bearerToken,
  issueSession,
  revokeSession,
  verifySession,
} from "../_shared/session.ts";
import {
  ADMIN_POLICY,
  clientIp,
  getIpSalt,
  hashIp,
  isRateLimited,
  recordAttempt,
} from "../_shared/rateLimit.ts";
import type {
  AdminMatchRow,
  AdminParticipantRow,
  CodeRow,
  ImpactRow,
  Session,
} from "../_shared/lib/types.ts";

/** Row shape returned by the admin_list_matches RPC (snake_case from SQL). */
interface MatchRpcRow {
  id: string;
  session: string;
  time_range: string;
  arrive_by: string;
  venue: string;
  male_team: string | null;
  female_team: string | null;
  male_id: string;
  male_name: string;
  male_birthdate: string;
  female_id: string;
  female_name: string;
  female_birthdate: string;
}

interface ParticipantDbRow {
  id: string;
  display_name: string;
  birthdate: string;
  gender: string;
  contact: string | null;
  email: string | null;
  team: string | null;
  code_sent_at: string | null;
}

/** Only `login` uses this. Every other action authenticates with a token. */
function isPasswordCorrect(req: Request): boolean {
  const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
  const provided = bearerToken(req);
  if (expected === "" || provided === "") return false;
  return timingSafeEqual(provided, expected);
}

async function listMatches(db: SupabaseClient): Promise<AdminMatchRow[] | null> {
  const { data, error } = await db.rpc("admin_list_matches").returns<
    MatchRpcRow[]
  >();
  if (error) {
    console.error("admin_list_matches failed", error);
    return null;
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    session: r.session as Session,
    timeRange: r.time_range,
    arriveBy: r.arrive_by,
    venue: r.venue,
    maleTeam: r.male_team,
    femaleTeam: r.female_team,
    maleId: r.male_id,
    maleName: r.male_name,
    maleBirthdate: r.male_birthdate,
    femaleId: r.female_id,
    femaleName: r.female_name,
    femaleBirthdate: r.female_birthdate,
  }));
}

async function listParticipants(
  db: SupabaseClient,
): Promise<AdminParticipantRow[] | null> {
  const { data, error } = await db
    .from("participants")
    .select("id, display_name, birthdate, gender, contact, email, team, code_sent_at")
    .order("display_name")
    .returns<ParticipantDbRow[]>();
  if (error) {
    console.error("participant listing failed", error);
    return null;
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    displayName: r.display_name,
    birthdate: r.birthdate,
    gender: r.gender as "M" | "F",
    contact: r.contact,
    email: r.email,
    team: r.team,
    codeSentAt: r.code_sent_at,
  }));
}

/** Row shape returned by matches_for_participant (snake_case from SQL). */
interface ImpactRpcRow {
  session: string;
  venue: string;
  team: string | null;
  partner_name: string;
}

/**
 * Reuses the RPC the participant lookup already depends on. It returns exactly
 * the fields the delete confirmation needs -- session, venue, team and the
 * partner's name -- so no new query is required.
 */
async function participantImpact(
  db: SupabaseClient,
  id: string,
): Promise<ImpactRow[] | null> {
  const { data, error } = await db
    .rpc("matches_for_participant", { p_id: id })
    .returns<ImpactRpcRow[]>();
  if (error) {
    console.error("participant_impact failed", error);
    return null;
  }
  return (data ?? []).map((r) => ({
    session: r.session as Session,
    venue: r.venue,
    team: r.team,
    partnerName: r.partner_name,
  }));
}

/**
 * Every code currently in use. Needed because a per-row salt makes it
 * impossible to test a candidate code without hashing it against each stored
 * salt, and a code alone now identifies a participant.
 */
async function takenCodes(db: SupabaseClient): Promise<TakenCode[] | null> {
  const { data, error } = await db
    .from("participants")
    .select("code_salt, code_hash")
    .returns<{ code_salt: string; code_hash: string }[]>();
  if (error) {
    console.error("taken code lookup failed", error);
    return null;
  }
  return (data ?? []).map((r) => ({ salt: r.code_salt, hash: r.code_hash }));
}

/**
 * A claim older than this belonged to a run that died mid-flight -- the same
 * five minutes claim_pending_codes (supabase/migrations/20260808000010) uses,
 * kept in lockstep here so an admin's manual send and cron agree on when a
 * claim is abandoned rather than merely in progress.
 */
const CLAIM_STALE_MS = 5 * 60_000;

/** Hands a claim this action took back, on every failure path after taking it. */
async function releaseSendClaim(
  db: SupabaseClient,
  id: string,
  claimId: string,
): Promise<void> {
  const { error } = await db
    .from("participants")
    .update({ send_claim_id: null, send_claimed_at: null })
    .eq("id", id)
    .eq("send_claim_id", claimId);
  if (error) console.error("send_code claim release failed", error);
}

/**
 * Whether automatic sending is armed. F7: a bulk code regeneration must
 * refuse while this is true, since it would otherwise hand cron a batch of
 * brand-new codes to mail within five minutes -- silently invalidating
 * whatever CSV the admin just downloaded.
 *
 * Fails closed the opposite way from send-codes' isArmed(): here an unreadable
 * flag must NOT let the bulk action through, because that risks invalidating
 * codes that may already be printed or distributed; refusing the action on a
 * transient read failure only costs the admin a retry.
 */
async function isSendArmed(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from("app_config")
    .select("value")
    .eq("key", "code_send_armed")
    .maybeSingle<{ value: string }>();
  if (error) {
    console.error("armed check failed", error);
    return true;
  }
  return data?.value === "true";
}

interface ParticipantInput {
  displayName: string;
  birthdate: string;
  gender: "M" | "F";
  contact: string | null;
  email: string | null;
  team: string | null;
}

function readParticipantInput(payload: unknown): ParticipantInput | null {
  const p = payload as Record<string, unknown>;
  const str = (key: string): string => typeof p[key] === "string" ? p[key] : "";

  const displayName = str("displayName").trim();
  const birthdate = str("birthdate").trim();
  const gender = str("gender");

  if (displayName === "") return null;
  // The column is a date; anything else makes Postgres raise instead of
  // returning a usable error to the operator.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  if (gender !== "M" && gender !== "F") return null;

  const contact = str("contact").trim();
  const email = str("email").trim();
  const team = str("team").trim();
  return {
    displayName,
    birthdate,
    gender,
    // Empty strings are stored as NULL so the participant screen and the code
    // CSV render a blank rather than an empty-looking value.
    contact: contact === "" ? null : contact,
    email: email === "" ? null : email,
    // Empty means "not assigned yet"; the participant screen renders NULL as
    // "조 배정 예정".
    team: team === "" ? null : team,
  };
}

/** Postgres unique_violation. Raised by participants_identity_key. */
function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

interface MatchInput {
  session: string;
  timeRange: string;
  arriveBy: string;
  venue: string;
  maleId: string;
  femaleId: string;
}

/**
 * Returns the validated fields, or null when anything required is missing.
 * timeRange and arriveBy are both required here even though the CSV path
 * derives them from the session: on a form where both boxes are visible,
 * filling one of them silently would make the saved value unpredictable.
 */
function readMatchInput(payload: unknown): MatchInput | null {
  const p = payload as Record<string, unknown>;
  const str = (key: string): string => typeof p[key] === "string" ? p[key] : "";

  const input: MatchInput = {
    session: str("session"),
    timeRange: str("timeRange").trim(),
    arriveBy: str("arriveBy").trim(),
    venue: str("venue").trim(),
    maleId: str("maleId"),
    femaleId: str("femaleId"),
  };

  if (input.session !== "1부" && input.session !== "2부") return null;
  if (input.timeRange === "" || input.arriveBy === "") return null;
  if (input.venue === "") return null;
  if (input.maleId === "" || input.femaleId === "") return null;
  return input;
}

/** A reason a match cannot be saved, ready to hand back to the operator. */
interface MatchConflict {
  error: string;
  /** Whose problem it is, so the message can name them. */
  name?: string;
  /** The match already holding them, for a "이미 여기 있습니다" line. */
  existing?: { session: string; timeRange: string; venue: string };
}

/**
 * Checks a proposed match against the people and the schedule.
 *
 * Everything here was previously accepted: the browser only ever sent ids from
 * the gender-filtered pickers, so nothing invalid arrived in practice. That is
 * the browser's behaviour, not a rule -- and the one thing the pickers cannot
 * see is whether the person is already booked.
 *
 * `excludeId` is the row being edited. Without it, saving a match unchanged
 * would report the row as its own conflict.
 */
async function findMatchConflict(
  db: SupabaseClient,
  input: MatchInput,
  excludeId: string | null,
): Promise<MatchConflict | null> {
  if (input.maleId === input.femaleId) return { error: "same_person" };

  const { data: people, error: peopleError } = await db
    .from("participants")
    .select("id, display_name, gender")
    .in("id", [input.maleId, input.femaleId])
    .returns<{ id: string; display_name: string; gender: string }[]>();
  if (peopleError) {
    console.error("match conflict participant lookup failed", peopleError);
    return { error: "server_error" };
  }

  const male = (people ?? []).find((p) => p.id === input.maleId);
  const female = (people ?? []).find((p) => p.id === input.femaleId);
  if (male === undefined || female === undefined) return { error: "not_found" };
  if (male.gender !== "M" || female.gender !== "F") {
    return { error: "wrong_gender" };
  }

  // One session is one time block, so a person in two rows of the same session
  // is being sent to two places at once. This is the check the operator asked
  // for; the CSV import path has no equivalent and never did.
  const { data: clashes, error: clashError } = await db
    .from("matches")
    .select("id, session, time_range, venue, male_id, female_id")
    .eq("session", input.session)
    .or(`male_id.eq.${input.maleId},female_id.eq.${input.femaleId}`)
    .returns<
      {
        id: string;
        session: string;
        time_range: string;
        venue: string;
        male_id: string;
        female_id: string;
      }[]
    >();
  if (clashError) {
    console.error("match conflict lookup failed", clashError);
    return { error: "server_error" };
  }

  for (const row of clashes ?? []) {
    if (row.id === excludeId) continue;
    const who = row.male_id === input.maleId
      ? male.display_name
      : row.female_id === input.femaleId
      ? female.display_name
      : null;
    if (who === null) continue;
    return {
      error: "already_scheduled",
      name: who,
      existing: {
        session: row.session,
        timeRange: row.time_range,
        venue: row.venue,
      },
    };
  }
  return null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handlePreflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "invalid_request" }, 405);
  }

  const db = createServiceClient();

  const salt = await getIpSalt(db);
  const ipHash = salt === null ? null : await hashIp(clientIp(req), salt);

  if (ipHash !== null && await isRateLimited(db, ipHash, ADMIN_POLICY)) {
    return jsonResponse(req, { error: "too_many_attempts", retryAfter: 900 }, 429);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }
  const action = (payload as { action?: unknown }).action;

  if (action === "login") {
    // Rate limiting keys on password failures only. A stale token is not an
    // attack, and counting it would lock the admin out of their own re-login.
    if (!isPasswordCorrect(req)) {
      if (ipHash !== null) {
        await recordAttempt(db, ipHash, false, ADMIN_POLICY);
      }
      return jsonResponse(req, { error: "unauthorized" }, 401);
    }
    const issued = await issueSession(db);
    if (issued === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, { token: issued });
  }

  const presented = bearerToken(req);
  if (!await verifySession(db, presented)) {
    return jsonResponse(req, { error: "unauthorized" }, 401);
  }

  if (action === "logout") {
    await revokeSession(db, presented);
    return jsonResponse(req, { ok: true });
  }

  if (action === "list_matches") {
    const matches = await listMatches(db);
    if (matches === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, { matches });
  }

  if (action === "list_participants") {
    const participants = await listParticipants(db);
    if (participants === null) {
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    return jsonResponse(req, { participants });
  }

  if (action === "create_match") {
    const input = readMatchInput(payload);
    if (input === null) return jsonResponse(req, { error: "invalid_request" }, 400);

    const conflict = await findMatchConflict(db, input, null);
    if (conflict !== null) {
      return jsonResponse(req, conflict, conflict.error === "server_error" ? 500 : 409);
    }

    const { data, error } = await db
      .from("matches")
      .insert({
        session: input.session,
        time_range: input.timeRange,
        arrive_by: input.arriveBy,
        venue: input.venue,
        male_id: input.maleId,
        female_id: input.femaleId,
      })
      .select("id")
      .single<{ id: string }>();

    if (error || data === null) {
      console.error("create_match failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    return jsonResponse(req, { id: data.id });
  }

  if (action === "update_match") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    const input = readMatchInput(payload);
    if (input === null) return jsonResponse(req, { error: "invalid_request" }, 400);

    // Excludes this row: re-saving a match without changing the people must
    // not report the row as clashing with itself.
    const conflict = await findMatchConflict(db, input, id);
    if (conflict !== null) {
      return jsonResponse(req, conflict, conflict.error === "server_error" ? 500 : 409);
    }

    const { data, error } = await db
      .from("matches")
      .update({
        session: input.session,
        time_range: input.timeRange,
        arrive_by: input.arriveBy,
        venue: input.venue,
        male_id: input.maleId,
        female_id: input.femaleId,
      })
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("update_match failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if ((data ?? []).length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    return jsonResponse(req, { ok: true });
  }

  if (action === "delete_match") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    const { data, error } = await db
      .from("matches")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("delete_match failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if ((data ?? []).length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    return jsonResponse(req, { ok: true });
  }

  if (action === "participant_impact") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    const matches = await participantImpact(db, id);
    if (matches === null) return jsonResponse(req, { error: "server_error" }, 500);
    return jsonResponse(req, { matches });
  }

  if (action === "create_participant") {
    const input = readParticipantInput(payload);
    if (input === null) return jsonResponse(req, { error: "invalid_request" }, 400);

    const taken = await takenCodes(db);
    if (taken === null) return jsonResponse(req, { error: "server_error" }, 500);
    const { code, salt, hash } = await mintUniqueCode(taken);

    const { data, error } = await db
      .from("participants")
      .insert({
        name: normalizeName(input.displayName),
        display_name: input.displayName,
        birthdate: input.birthdate,
        gender: input.gender,
        contact: input.contact,
        email: input.email,
        team: input.team,
        code_salt: salt,
        code_hash: hash,
      })
      .select("id")
      .single<{ id: string }>();

    if (isDuplicate(error)) {
      return jsonResponse(req, { error: "duplicate_participant" }, 409);
    }
    if (error || data === null) {
      console.error("create_participant failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    // The plaintext is returned exactly once; only its hash is stored.
    return jsonResponse(req, { id: data.id, code });
  }

  if (action === "update_participant") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    const input = readParticipantInput(payload);
    if (input === null) return jsonResponse(req, { error: "invalid_request" }, 400);

    // F4: whether the email is actually changing decides whether an in-flight
    // claim must be abandoned. Read the current value first rather than
    // comparing against whatever the browser might echo back.
    const { data: current, error: currentError } = await db
      .from("participants")
      .select("email")
      .eq("id", id)
      .maybeSingle<{ email: string | null }>();
    if (currentError) {
      console.error("update_participant lookup failed", currentError);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if (current === null) return jsonResponse(req, { error: "not_found" }, 404);

    const emailChanged = current.email !== input.email;

    const update: Record<string, unknown> = {
      // code_salt and code_hash are deliberately absent: renaming someone
      // must not invalidate the code they were already given.
      name: normalizeName(input.displayName),
      display_name: input.displayName,
      birthdate: input.birthdate,
      gender: input.gender,
      contact: input.contact,
      email: input.email,
      team: input.team,
      // The admin editing this row is the explicit signal that the address
      // is worth trying again.
      send_attempts: 0,
      send_last_error: null,
    };
    if (emailChanged) {
      // An in-flight send holds the OLD email in memory. If the address is
      // unchanged, that send is still going somewhere correct and must be
      // left alone -- cancelling it would only produce a redundant second
      // mail. If the address changed, it is going somewhere wrong and must
      // be abandoned so the row stays pending and is re-sent to the new
      // address. Mirrors the rule migration ...0011 applies for code changes.
      update.send_claim_id = null;
      update.send_claimed_at = null;
    }

    const { data, error } = await db
      .from("participants")
      .update(update)
      .eq("id", id)
      .select("id");

    if (isDuplicate(error)) {
      return jsonResponse(req, { error: "duplicate_participant" }, 409);
    }
    if (error) {
      console.error("update_participant failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if ((data ?? []).length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    return jsonResponse(req, { ok: true });
  }

  if (action === "delete_participant") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    // matches.male_id / female_id are ON DELETE CASCADE, so this also removes
    // the person's matches. The UI shows that impact before calling here.
    const { data, error } = await db
      .from("participants")
      .delete()
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("delete_participant failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if ((data ?? []).length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    return jsonResponse(req, { ok: true });
  }

  if (action === "send_code") {
    const id = (payload as { id?: unknown }).id;
    const rawCode = (payload as { code?: unknown }).code;
    if (typeof id !== "string" || id === "" || typeof rawCode !== "string" || rawCode === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    // F8: reject malformed input before touching the row at all. This is the
    // same validator the lookup path already trusts, so no new alphabet check
    // is introduced. Beyond defence in depth (sendCodeEmail also escapes the
    // code), this rejects garbage early rather than claiming a row for a
    // request that can only ever end in stale_code.
    if (!isValidCode(rawCode)) {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }
    const code = normalizeCode(rawCode);

    // F2: this action used to take no claim at all, so a concurrent cron tick
    // could re-mint this row's code while the admin's browser still held the
    // old plaintext on screen -- mailing a code the database no longer holds.
    // Claim first, exactly like claim_pending_codes: unclaimed, or a claim
    // stale enough that its run must have died.
    const claimId = crypto.randomUUID();
    const staleBefore = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
    const { data: claimedRows, error: claimError } = await db
      .from("participants")
      .update({ send_claim_id: claimId, send_claimed_at: new Date().toISOString() })
      .eq("id", id)
      .or(`send_claim_id.is.null,send_claimed_at.lt.${staleBefore}`)
      .select("display_name, email, code_salt, code_hash")
      .returns<
        { display_name: string; email: string | null; code_salt: string; code_hash: string }[]
      >();
    if (claimError) {
      console.error("send_code claim failed", claimError);
      return jsonResponse(req, { error: "server_error" }, 500);
    }

    const claimed = (claimedRows ?? [])[0];
    if (claimed === undefined) {
      // Zero rows is ambiguous by construction: either the id does not exist,
      // or a live run (cron or another admin tab) currently holds the claim.
      // A read-only existence check tells the two apart without racing the
      // claim update itself.
      const { data: exists } = await db
        .from("participants")
        .select("id")
        .eq("id", id)
        .maybeSingle<{ id: string }>();
      if (exists === null) return jsonResponse(req, { error: "not_found" }, 404);
      return jsonResponse(req, { error: "send_in_progress" }, 409);
    }

    // From here on this request holds the claim. Every exit from this point
    // -- an early return, the stamp write erroring, or an exception thrown by
    // hashCode/sendCodeEmail/response building -- must hand it back, mirroring
    // run()'s finally in send-codes/index.ts. Without this, a stamp error or a
    // thrown exception used to leak the claim: the row was then invisible to
    // both the sender and this action for the full five-minute stale window,
    // and on the stamp-error path specifically that also means a duplicate
    // code mailed later. releaseSendClaim is already guarded by claimId (its
    // update matches `.eq("send_claim_id", claimId)`), so calling it here
    // unconditionally is safe: it is a no-op both when stamp() already cleared
    // the claim on success, and when a DIFFERENT run has since taken it.
    try {
      if (claimed.email === null || claimed.email === "") {
        return jsonResponse(req, { error: "no_email" }, 400);
      }

      // The plaintext comes back from the browser because the server never kept
      // it; only its hash is stored. But by the time this request lands, a
      // claimed cron run may already have minted and mailed a NEW code for this
      // row -- so the presented plaintext must be checked against what is
      // actually stored right now, with the same normalisation the lookup path
      // uses, before it is sent anywhere.
      const digest = await hashCode(claimed.code_salt, code);
      if (!timingSafeEqual(digest, claimed.code_hash)) {
        return jsonResponse(req, { error: "stale_code" }, 400);
      }

      const result = await sendCodeEmail(claimed.email, claimed.display_name, code);
      if (result.kind === "disabled") {
        return jsonResponse(req, { error: "email_disabled" }, 400);
      }
      if (result.kind !== "sent") {
        return jsonResponse(req, { error: "email_failed" }, 502);
      }

      // Stamped only after the send succeeds, guarded by the claim this request
      // took: if something re-minted the code while the mail was in flight, this
      // writes zero rows and the row correctly stays pending for the new code.
      const { error: stampError } = await db
        .from("participants")
        .update({ code_sent_at: new Date().toISOString(), send_claim_id: null, send_claimed_at: null })
        .eq("id", id)
        .eq("send_claim_id", claimId);
      if (stampError) {
        // The mail is already gone; failing the request would tell the operator
        // to send again. Log it and report success -- the worst case is that this
        // participant looks unsent and gets a fresh code later. The claim is
        // still released below by the finally, so this row does not also
        // disappear from the sender's view for five minutes on top of that.
        console.error("send_code stamp failed", stampError);
      }
      return jsonResponse(req, { ok: true, email: claimed.email });
    } finally {
      await releaseSendClaim(db, id, claimId);
    }
  }

  if (action === "regenerate_codes") {
    // F7: this sets code_sent_at null for every target, which makes each one
    // claimable immediately. If automatic sending is armed, the next cron
    // tick within five minutes mints brand-new codes for all of them and
    // mails those -- silently invalidating whatever CSV the admin just
    // downloaded to print or distribute offline. regenerate_code (singular)
    // is deliberately exempt: reissuing one person and mailing them right
    // away is a legitimate armed-time workflow, and F2 makes that path safe.
    if (await isSendArmed(db)) {
      return jsonResponse(req, { error: "armed_conflict" }, 409);
    }

    // No ids means everyone. A subset keeps the untouched participants' codes
    // valid, so those codes stay in the uniqueness guard below.
    const rawIds = (payload as { ids?: unknown }).ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((v): v is string => typeof v === "string" && v !== "")
      : null;
    if (ids !== null && ids.length === 0) {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }

    const { data, error } = await db
      .from("participants")
      .select("id, display_name, gender, contact, email, code_salt, code_hash")
      .order("display_name")
      .returns<
        {
          id: string;
          display_name: string;
          gender: string;
          contact: string | null;
          email: string | null;
          code_salt: string;
          code_hash: string;
        }[]
      >();
    if (error) {
      console.error("regenerate_codes listing failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }

    const all = data ?? [];
    const targets = ids === null ? all : all.filter((p) => ids.includes(p.id));
    if (targets.length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }

    // Participants who keep their code must stay in the guard: a new code must
    // not collide with one that is still in circulation.
    const targetIds = new Set(targets.map((p) => p.id));
    const taken: TakenCode[] = all
      .filter((p) => !targetIds.has(p.id))
      .map((p) => ({ salt: p.code_salt, hash: p.code_hash }));
    const rows: CodeRow[] = [];

    for (const p of targets) {
      const minted = await mintUniqueCode(taken);
      taken.push({ salt: minted.salt, hash: minted.hash });

      const { error: writeError } = await db
        .from("participants")
        // code_sent_at goes with the code it described: the participant has
        // not been sent this new one.
        .update({
          code_salt: minted.salt,
          code_hash: minted.hash,
          code_sent_at: null,
          send_attempts: 0,
          send_last_error: null,
          // A new code invalidates any send that claimed the old one.
          send_claim_id: null,
          send_claimed_at: null,
        })
        .eq("id", p.id);
      if (writeError) {
        // Stop rather than continue: a partial pass would leave some codes
        // replaced and some not, with no record of which.
        console.error("regenerate_codes write failed", writeError);
        return jsonResponse(req, { error: "server_error" }, 500);
      }

      rows.push({
        displayName: p.display_name,
        gender: p.gender as "M" | "F",
        contact: p.contact,
        email: p.email,
        code: minted.code,
      });
    }

    // The plaintext exists only in this response; the table keeps hashes.
    return jsonResponse(req, { count: rows.length, codesCsv: buildCodesCsv(rows) });
  }

  if (action === "regenerate_code") {
    const id = (payload as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") {
      return jsonResponse(req, { error: "invalid_request" }, 400);
    }

    const taken = await takenCodes(db);
    if (taken === null) return jsonResponse(req, { error: "server_error" }, 500);
    const { code, salt, hash } = await mintUniqueCode(taken);

    const { data, error } = await db
      .from("participants")
      .update({
        code_salt: salt,
        code_hash: hash,
        code_sent_at: null,
        send_attempts: 0,
        send_last_error: null,
        // A new code invalidates any send that claimed the old one.
        send_claim_id: null,
        send_claimed_at: null,
      })
      .eq("id", id)
      .select("id");

    if (error) {
      console.error("regenerate_code failed", error);
      return jsonResponse(req, { error: "server_error" }, 500);
    }
    if ((data ?? []).length === 0) {
      return jsonResponse(req, { error: "not_found" }, 404);
    }
    // Returned once. The previous code is unrecoverable from this point.
    return jsonResponse(req, { code });
  }

  return jsonResponse(req, { error: "invalid_request" }, 400);
});
