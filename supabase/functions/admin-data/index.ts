import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { timingSafeEqual } from "../_shared/hash.ts";
import { mintUniqueCode, type TakenCode } from "../_shared/mintCode.ts";
import { buildCodesCsv } from "../_shared/lib/csv.ts";
import { normalizeName } from "../_shared/lib/name.ts";
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
  team: string | null;
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
    team: r.team,
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
    .select("id, display_name, birthdate, gender, contact, email")
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

interface ParticipantInput {
  displayName: string;
  birthdate: string;
  gender: "M" | "F";
  contact: string | null;
  email: string | null;
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
  return {
    displayName,
    birthdate,
    gender,
    // Empty strings are stored as NULL so the participant screen and the code
    // CSV render a blank rather than an empty-looking value.
    contact: contact === "" ? null : contact,
    email: email === "" ? null : email,
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
  team: string;
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
    team: str("team").trim(),
    maleId: str("maleId"),
    femaleId: str("femaleId"),
  };

  if (input.session !== "1부" && input.session !== "2부") return null;
  if (input.timeRange === "" || input.arriveBy === "") return null;
  if (input.venue === "") return null;
  if (input.maleId === "" || input.femaleId === "") return null;
  return input;
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

    const { data, error } = await db
      .from("matches")
      .insert({
        session: input.session,
        time_range: input.timeRange,
        arrive_by: input.arriveBy,
        venue: input.venue,
        // Empty means "not assigned yet"; the column is nullable and the
        // participant screen renders NULL as "조 배정 예정".
        team: input.team === "" ? null : input.team,
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

    const { data, error } = await db
      .from("matches")
      .update({
        session: input.session,
        time_range: input.timeRange,
        arrive_by: input.arriveBy,
        venue: input.venue,
        team: input.team === "" ? null : input.team,
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

    // code_salt and code_hash are deliberately absent: renaming someone must
    // not invalidate the code they were already given.
    const { data, error } = await db
      .from("participants")
      .update({
        name: normalizeName(input.displayName),
        display_name: input.displayName,
        birthdate: input.birthdate,
        gender: input.gender,
        contact: input.contact,
        email: input.email,
      })
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

  if (action === "regenerate_codes") {
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
        .update({ code_salt: minted.salt, code_hash: minted.hash })
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
      .update({ code_salt: salt, code_hash: hash })
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
