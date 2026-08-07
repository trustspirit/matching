import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { DUMMY_SALT, hashCode, timingSafeEqual } from "../_shared/hash.ts";
import {
  clientIp,
  hashIp,
  isRateLimited,
  recordAttempt,
} from "../_shared/rateLimit.ts";
import { isValidCode, normalizeCode } from "../_shared/lib/code.ts";
import { normalizeName } from "../_shared/lib/name.ts";
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

  const body = payload as { name?: unknown; code?: unknown };
  const rawName = typeof body.name === "string" ? body.name : "";
  const rawCode = typeof body.code === "string" ? body.code : "";
  if (rawName.trim() === "" || !isValidCode(rawCode)) {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  const db = createServiceClient();
  const ipHash = await hashIp(clientIp(req));

  if (await isRateLimited(db, ipHash)) {
    return jsonResponse(req, { error: "too_many_attempts", retryAfter: 60 }, 429);
  }

  const name = normalizeName(rawName);
  const code = normalizeCode(rawCode);

  const { data: candidates, error: candidatesError } = await db
    .from("participants")
    .select("id, display_name, code_salt, code_hash")
    .eq("name", name)
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
    if (timingSafeEqual(digest, candidate.code_hash)) {
      matched = candidate;
      break;
    }
  }

  if (matched === null) {
    // Burn one hash so an unknown name costs the same as a wrong code.
    await hashCode(DUMMY_SALT, code);
    await recordAttempt(db, ipHash, false);
    return jsonResponse(req, { error: "invalid_credentials" }, 401);
  }

  const { data: rows, error } = await db
    .rpc("matches_for_participant", { p_id: matched.id })
    .returns<MatchRow[]>();

  if (error) {
    return jsonResponse(req, { error: "server_error" }, 500);
  }

  await recordAttempt(db, ipHash, true);

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
