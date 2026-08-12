import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/db.ts";
import {
  ADMIN_POLICY,
  clientIp,
  getIpSalt,
  hashIp,
  isRateLimited,
} from "../_shared/rateLimit.ts";
import { bearerToken, verifySession } from "../_shared/session.ts";
import { mintUniqueCode } from "../_shared/mintCode.ts";
import { buildCodesCsv, parseMatchCsv } from "../_shared/lib/csv.ts";
import type { CodeRow, ParsedPerson } from "../_shared/lib/types.ts";

/** Identity key for a participant, matching the DB's unique constraint. */
function personKey(person: ParsedPerson): string {
  return `${person.name}|${person.birthdate}`;
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
    return jsonResponse(
      req,
      { error: "too_many_attempts", retryAfter: 900 },
      429,
    );
  }

  // The password never reaches this function any more: admin-data's `login`
  // exchanges it for a token, and failed password guesses are counted there.
  // The rate limit check above stays so a locked-out admin cannot upload
  // either.
  if (!await verifySession(db, bearerToken(req))) {
    return jsonResponse(req, { error: "unauthorized" }, 401);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse(req, { error: "invalid_request" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonResponse(req, { error: "invalid_request", errors: ["파일이 없습니다."] }, 400);
  }
  const regenerateCodes = form.get("regenerateCodes") === "true";

  const parsed = parseMatchCsv(await file.text());
  if (parsed.errors.length > 0) {
    // Nothing is written when parsing fails: the import is all-or-nothing.
    return jsonResponse(req, { error: "invalid_csv", errors: parsed.errors }, 400);
  }

  // Deduplicate people across rows. A woman attending twice appears in two
  // rows but is one participant.
  const people = new Map<string, ParsedPerson>();
  for (const match of parsed.matches) {
    people.set(personKey(match.male), match.male);
    people.set(personKey(match.female), match.female);
  }

  // The codes come along for two reasons: a newly minted one must not collide
  // with a code already in use (a code alone identifies a participant, so two
  // people sharing one would let each read the other's match), and a
  // participant whose code is being kept still belongs in the downloaded CSV.
  const { data: existingRows, error: existingError } = await db
    .from("participants")
    .select("name, birthdate, code")
    .returns<{ name: string; birthdate: string; code: string }[]>();
  if (existingError) {
    return jsonResponse(req, { error: "server_error" }, 500);
  }
  const existing = new Map(
    (existingRows ?? []).map((row) => [`${row.name}|${row.birthdate}`, row.code]),
  );
  const taken = new Set((existingRows ?? []).map((row) => row.code));

  const participantPayload: Record<string, unknown>[] = [];
  const codeRows: CodeRow[] = [];
  let created = 0;
  let updated = 0;

  for (const person of people.values()) {
    const storedCode = existing.get(personKey(person));
    const isNew = storedCode === undefined;
    if (isNew) created++;
    else updated++;

    const minted = isNew || regenerateCodes ? mintUniqueCode(taken) : null;

    participantPayload.push({
      name: person.name,
      display_name: person.displayName,
      birthdate: person.birthdate,
      gender: person.gender,
      contact: person.contact ?? "",
      email: person.email ?? "",
      // Empty means "not assigned yet"; import_matches turns it back into NULL.
      team: person.team ?? "",
      // An empty string tells import_matches to keep the stored code.
      code: minted ?? "",
    });

    codeRows.push({
      displayName: person.displayName,
      gender: person.gender,
      contact: person.contact,
      email: person.email,
      // Everyone's real code, not just the freshly minted ones. The CSV used
      // to leave a blank for a participant whose code was kept, because the
      // server could not read it back.
      code: minted ?? storedCode ?? null,
    });
  }

  const matchPayload = parsed.matches.map((match) => ({
    session: match.session,
    time_range: match.timeRange,
    arrive_by: match.arriveBy,
    venue: match.venue,
    male_name: match.male.name,
    male_birthdate: match.male.birthdate,
    female_name: match.female.name,
    female_birthdate: match.female.birthdate,
  }));

  const { error: importError } = await db.rpc("import_matches", {
    payload: { participants: participantPayload, matches: matchPayload },
  });
  if (importError) {
    return jsonResponse(
      req,
      { error: "server_error", errors: [importError.message] },
      500,
    );
  }

  return jsonResponse(req, {
    participants: { created, updated },
    matches: parsed.matches.length,
    warnings: parsed.warnings,
    codesCsv: buildCodesCsv(codeRows),
  });
});
