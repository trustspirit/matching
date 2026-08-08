import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { DUMMY_SALT, hashCode, timingSafeEqual } from "../_shared/hash.ts";
import {
  clientIp,
  getIpSalt,
  hashIp,
  isRateLimited,
  PARTICIPANT_POLICY,
  recordAttempt,
} from "../_shared/rateLimit.ts";
import { isValidCode, normalizeCode } from "../_shared/lib/code.ts";
import type { LookupResponse, MatchView } from "../_shared/lib/types.ts";

interface ParticipantRow {
  id: string;
  display_name: string;
  code_salt: string;
  code_hash: string;
}

interface MatchRow {
  session: string;
  time_range: string;
  arrive_by: string;
  venue: string;
  team: string | null;
  partner_name: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handlePreflight(req);
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "invalid_request" }, 405);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  const body = payload as { code?: unknown };
  const rawCode = typeof body.code === "string" ? body.code : "";
  if (!isValidCode(rawCode)) {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  const db = createServiceClient();

  // A null salt means rate limiting is unavailable this request. Fail open:
  // locking every participant out during the event is worse than briefly
  // losing the throttle (same reasoning as isRateLimited below).
  const salt = await getIpSalt(db);
  const ipHash = salt === null ? null : await hashIp(clientIp(req), salt);

  if (ipHash !== null && await isRateLimited(db, ipHash, PARTICIPANT_POLICY)) {
    return jsonResponse(req, { error: "too_many_attempts", retryAfter: 60 }, 429);
  }

  const code = normalizeCode(rawCode);

  // Every participant is a candidate: the per-row salt means a code cannot be
  // looked up by hash, so the only way to find its owner is to hash the input
  // against each stored salt. At ~350 participants that is ~350 SHA-256 per
  // login, which is microseconds. import_matches guarantees the codes are
  // unique, so at most one row can match.
  const { data: candidates, error: candidatesError } = await db
    .from("participants")
    .select("id, display_name, code_salt, code_hash")
    .returns<ParticipantRow[]>();

  if (candidatesError) {
    // A DB fault here must not be mistaken for "wrong code": falling through
    // to invalid_credentials would record a failed attempt against the
    // participant's IP and could trip the rate limiter during an outage.
    console.error("participant lookup failed", candidatesError);
    return jsonResponse(req, { error: "server_error" }, 500);
  }

  let matched: ParticipantRow | null = null;
  for (const candidate of candidates ?? []) {
    const digest = await hashCode(candidate.code_salt, code);
    // No early break: hashing every row keeps the response time independent of
    // where in the table the match sits.
    if (timingSafeEqual(digest, candidate.code_hash)) matched = candidate;
  }

  if (matched === null) {
    // Burn one hash so an unknown name costs the same as a wrong code.
    await hashCode(DUMMY_SALT, code);
    if (ipHash !== null) {
      await recordAttempt(db, ipHash, false, PARTICIPANT_POLICY);
    }
    return jsonResponse(req, { error: "invalid_credentials" }, 401);
  }

  const { data: rows, error } = await db
    .rpc("matches_for_participant", { p_id: matched.id })
    .returns<MatchRow[]>();

  if (error) {
    return jsonResponse(req, { error: "server_error" }, 500);
  }

  if (ipHash !== null) {
    await recordAttempt(db, ipHash, true, PARTICIPANT_POLICY);
  }

  const matches: MatchView[] = (rows ?? []).map((row) => ({
    session: row.session as MatchView["session"],
    timeRange: row.time_range,
    arriveBy: row.arrive_by,
    venue: row.venue,
    team: row.team,
    partnerName: row.partner_name,
  }));

  const response: LookupResponse = {
    displayName: matched.display_name,
    matches,
  };
  return jsonResponse(req, response);
});
