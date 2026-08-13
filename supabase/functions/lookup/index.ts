import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import {
  clientIp,
  getIpSalt,
  hashIp,
  isRateLimited,
  PARTICIPANT_POLICY,
  recordAttempt,
} from "../_shared/rateLimit.ts";
import { isValidCode, normalizeCode } from "../_shared/lib/code.ts";
import { revealKey } from "../_shared/lib/revealTime.ts";
import type {
  LookupResponse,
  MatchView,
  Session,
} from "../_shared/lib/types.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ParticipantRow {
  id: string;
  display_name: string;
}

/**
 * When each session's partner information opens, keyed by session.
 *
 * A session with no configured instant is open: the gate is something an
 * organiser switches on by setting a time, so an absent row must not black out
 * a screen nobody meant to gate. An unreadable table is the opposite case and
 * is handled by the caller -- see readRevealTimes' return of null.
 */
async function readRevealTimes(
  db: SupabaseClient,
): Promise<Map<string, Date> | null> {
  const { data, error } = await db
    .from("app_config")
    .select("key, value")
    .in("key", [revealKey("1부"), revealKey("2부")])
    .returns<{ key: string; value: string }[]>();
  if (error) {
    console.error("reveal time lookup failed", error);
    return null;
  }
  const times = new Map<string, Date>();
  for (const row of data ?? []) {
    const at = new Date(row.value);
    // A malformed value is worse than no value: it would silently resolve to
    // "already open" on every comparison. Treat it as unreadable instead.
    if (Number.isNaN(at.getTime())) {
      console.error("reveal time is not a date", row.key, row.value);
      return null;
    }
    times.set(row.key, at);
  }
  return times;
}

interface MatchRow {
  session: string;
  time_range: string;
  arrive_by: string;
  venue: string;
  team: string | null;
  partner_team: string | null;
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

  // A single indexed lookup. This used to read every participant and hash the
  // input once per row, because a per-row salt made the stored digest
  // unsearchable; the code is stored as itself now, and the unique index means
  // at most one row can match.
  //
  // That also drops the constant-time comparison this path used to do. It was
  // guarding against an attacker measuring which stored code an input got
  // closest to, which no longer has anything to measure: the only signal left
  // is whether a code exists, and guessing one out of 7.29e8 is what the IP
  // rate limiter above is for.
  const { data: matched, error: lookupError } = await db
    .from("participants")
    .select("id, display_name")
    .eq("code", code)
    .maybeSingle<ParticipantRow>();

  if (lookupError) {
    // A DB fault here must not be mistaken for "wrong code": falling through
    // to invalid_credentials would record a failed attempt against the
    // participant's IP and could trip the rate limiter during an outage.
    console.error("participant lookup failed", lookupError);
    return jsonResponse(req, { error: "server_error" }, 500);
  }

  if (matched === null) {
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

  // Read once for the whole response rather than per match, and taken before
  // the loop so every card in one response is judged against the same instant.
  const revealTimes = await readRevealTimes(db);
  const now = Date.now();

  const matches: MatchView[] = (rows ?? []).map((row) => {
    const session = row.session as Session;
    const revealAt = revealTimes?.get(revealKey(session)) ?? null;
    // An unreadable config withholds too, and says nothing about when: showing
    // a partner early cannot be undone, while a participant who meets the
    // placeholder for a moment can simply look again.
    const locked = revealTimes === null ||
      (revealAt !== null && now < revealAt.getTime());

    return {
      session,
      timeRange: row.time_range,
      arriveBy: row.arrive_by,
      venue: row.venue,
      // The viewer's own 조 is theirs to see: it is on their badge and their
      // table, and it identifies nobody else.
      team: row.team,
      partnerTeam: locked ? null : row.partner_team,
      partnerName: locked ? null : row.partner_name,
      revealAt: locked ? revealAt?.toISOString() ?? null : null,
    };
  });

  const response: LookupResponse = {
    displayName: matched.display_name,
    matches,
  };
  return jsonResponse(req, response);
});
