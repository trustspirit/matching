import type { SupabaseClient } from "@supabase/supabase-js";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import { timingSafeEqual } from "../_shared/hash.ts";
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

function isAuthorized(req: Request): boolean {
  const expected = Deno.env.get("ADMIN_PASSWORD") ?? "";
  const header = req.headers.get("Authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
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

  // Shares admin-import's counter on purpose: to an attacker, guessing the
  // password against either function is the same thing.
  if (!isAuthorized(req)) {
    if (ipHash !== null) {
      await recordAttempt(db, ipHash, false, ADMIN_POLICY);
    }
    return jsonResponse(req, { error: "unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }
  const action = (payload as { action?: unknown }).action;

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

  return jsonResponse(req, { error: "invalid_request" }, 400);
});
